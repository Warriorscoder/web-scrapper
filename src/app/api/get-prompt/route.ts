import { NextResponse } from 'next/server';
import { ChatGroq } from "@langchain/groq";
import { JsonOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
import { OutputFixingParser } from "langchain/output_parsers"; // Import the self-correcting parser
import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import axios from 'axios';
import { chromium } from 'playwright';

// --- STAGE 1: AI PLANNER ---

const planSchema = z.object({
    searchApiQuery: z.string().describe("A highly optimized, single-line search query string to be used with a Google Search API."),
    extractionPrompt: z.string().describe("A detailed prompt for a different AI model that will run later to extract structured data from the raw search results according to the user's intent."),
});
type Plan = z.infer<typeof planSchema>;
const planParser = StructuredOutputParser.fromZodSchema(planSchema);

const getPlanFromLLM = async (userPrompt: string): Promise<Plan> => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set in environment variables.");

    const model = new ChatGroq({
        apiKey,
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0.2,
        maxRetries: 0
    });

    const promptTemplate = new PromptTemplate({
        template: `You are an expert AI planner for a generalized web scraping system. Your task is to take a user's request and output a structured JSON plan.

        Steps:
        1. Analyze Intent: Understand the user’s explicit request AND infer the implicit, commonly expected details for that type of data. (Example: for jobs → company, role, salary, job description, apply link; for restaurants → name, address, rating, cuisine, contact; for products → title, price, brand, description, buy link).
        2. Define Schema: Build a schema that covers both explicit fields requested by the user and reasonable implicit fields that users would expect for this type of query. Keep field names concise and consistent.
        3. Generate Plan: Return a JSON object with two keys:
        - searchApiQuery → A focused query for Google Search API that is broad enough to find reliable sources, but precise enough to target authoritative directories, review platforms, or relevant sites.
        - extractionPrompt → A detailed instruction for extracting structured data from raw JSON/HTML. It must:
            • List each field from the schema explicitly.
            • Include both requested and inferred fields.
            • Use "N/A" when a field is missing.
            • Be reusable across varied website structures.

        Rules:
        - Output must be a valid JSON object only (no text or markdown).
        - Always balance explicit user needs with implicit expectations for that domain.
        - Ensure schema is suitable for tabular export (Excel/CSV).
        - Field values should be clean, human-readable, and consistent.
        - exclude LinkedIn from search
        - exclude Reddit from search 
        {format_instructions}

        User’s request:
        ${userPrompt}`,
        inputVariables: ["prompt"],
        partialVariables: { format_instructions: planParser.getFormatInstructions() },
    });

    const chain = promptTemplate.pipe(model).pipe(planParser);

    console.log("Invoking LangChain chain to generate plan...");
    return await chain.invoke({ prompt: userPrompt });
};


// --- STAGE 2: GOOGLE SEARCH EXECUTION ---

interface GoogleSearchItem {
    link: string;
}

const findRelevantUrls = async (searchQuery: string, numResults = 2): Promise<string[]> => {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;

    if (!apiKey || !cseId) {
        throw new Error("Google API Key or CSE ID is not set.");
    }

    let allUrls: string[] = [];
    const numRequests = Math.ceil(numResults / 10);

    for (let i = 0; i < numRequests; i++) {
        const startIndex = i * 10 + 1;
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(searchQuery)}&start=${startIndex}`;

        console.log(`Executing Google Search (Page ${i + 1}) with query: ${searchQuery}`);

        try {
            const response = await axios.get(url);
            const items: GoogleSearchItem[] = response.data.items || [];
            const urls = items.map((item) => item.link);
            allUrls = allUrls.concat(urls);


            if (items.length < 10) {
                break;
            }
        } catch (error) {
            console.error(`Error fetching page ${i + 1} of Google Search results:`, error);
            break;
        }
    }

    return allUrls.slice(0, numResults);
};

// ----- Stage-3 This is the real "Field Agent" scraper using Playwright -----

// A simple helper function to pause execution for a given number of milliseconds
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const scrapeFullPageContent = async (url: string): Promise<string> => {
    console.log(`--- Starting scrape for: ${url} ---`);
    let browser = null;
    try {
        browser = await chromium.launch({ headless: true });

        // ** NECESSARY CHANGE 1: Set realistic browser headers **
        // This makes your scraper look more like a real user's browser.
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
            },
        });

        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ** NECESSARY CHANGE 2: Add a small, random delay to mimic human behavior **
        // This pauses the script for 1 to 3 seconds.
        const randomDelay = 1000 + Math.random() * 2000;
        console.log(`--- Pausing for ${Math.round(randomDelay / 1000)}s before extracting content... ---`);
        await sleep(randomDelay);

        // Extract only the visible text from the body to get clean data
        const bodyText = await page.locator('body').innerText();

        console.log(`--- Finished scrape for: ${url} ---`);
        return bodyText;
    } catch (error) {
        console.error(`Failed to scrape ${url}:`, error);
        return `Error scraping ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};

// --- STAGE 3: AI EXTRACTOR ---
// ** NECESSARY CHANGE: This function now uses the OutputFixingParser for resilience **
const extractStructuredData = async (extractionPrompt: string, content: string) => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set in environment variables.");
    
    const model = new ChatGroq({
        apiKey,
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0,
        maxRetries: 0
    });

    const promptTemplate = new PromptTemplate({
        template: `${extractionPrompt}
        
        Here is the raw text scraped from the web pages:
        ---
        {raw_content}
        ---
        
        Your response must be ONLY the valid JSON data you have extracted.`,
        inputVariables: ["extraction_prompt", "raw_content"],
    });

    // 1. Create the primary parser that might fail.
    const primaryParser = new JsonOutputParser();

    // 2. Create the self-correcting parser that wraps the primary one.
    const outputFixingParser = OutputFixingParser.fromLLM(model, primaryParser);
    
    // 3. The chain now ends with our robust, self-healing parser.
    const chain = promptTemplate.pipe(model).pipe(outputFixingParser);

    console.log("Invoking LangChain chain to extract structured data...");
    return await chain.invoke({
        extraction_prompt: extractionPrompt,
        raw_content: content
    });
};

// --- MAIN API HANDLER ---

export async function POST(req: Request) {
    const { prompt } = await req.json();
    if (!prompt) {
        return NextResponse.json({ message: 'Prompt is required' }, { status: 400 });
    }
    try {
        // STAGE 1: Generate the plan
        const plan = await getPlanFromLLM(prompt);
        console.log("Stage 1 complete. Generated plan:", plan);

        // STAGE 2: Find URLs and scrape their content
        const urls = await findRelevantUrls(plan.searchApiQuery);
        // Scrape a smaller number of URLs to avoid timeouts in a serverless environment
        const urlsToScrape = urls.slice(0, 5);
        console.log(`Stage 2 complete. Found ${urls.length} URLs, scraping top ${urlsToScrape.length}.`);

        const scrapedContents = await Promise.all(
            urlsToScrape.map(url => scrapeFullPageContent(url))
        );

        console.log('scrapedContents', scrapedContents);
        const combinedContent = scrapedContents.join('\n\n---\n\n');

        // STAGE 3: Extract structured data
        const structuredData = await extractStructuredData(plan.extractionPrompt, combinedContent);
        console.log("Stage 3 complete. Extracted structured data:", structuredData);

        console.log("--- Workflow Complete. Returning final data. ---");
        return NextResponse.json({
            plan,
            structuredData
        }, { status: 200 });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown server error occurred';
        if (errorMessage.includes("429")) {
            return NextResponse.json({ message: 'Rate limit exceeded. Please wait.' }, { status: 429 });
        }
        console.error("Error in API handler:", error);
        return NextResponse.json({ message: errorMessage }, { status: 500 });
    }
}

