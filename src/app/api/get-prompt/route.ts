// import { NextResponse } from 'next/server';
// import { ChatGroq } from "@langchain/groq";
// import { JsonOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
// import { OutputFixingParser } from "langchain/output_parsers";
// import { PromptTemplate } from "@langchain/core/prompts";
// import { z } from "zod";
// import axios from 'axios';
// import { chromium, BrowserContext } from 'playwright';
// import { redis } from '../../../lib/redis'; 

// // --- STAGE 1: AI PLANNER ---

// const planSchema = z.object({
//     searchApiQuery: z.string().describe("A highly optimized, single-line search query string to be used with a Google Search API."),
//     extractionPrompt: z.string().describe("A detailed prompt for a different AI model that will run later to extract structured data from the raw search results according to the user's intent."),
// });
// type Plan = z.infer<typeof planSchema>;
// const planParser = StructuredOutputParser.fromZodSchema(planSchema);

// const getPlanFromLLM = async (userPrompt: string): Promise<Plan> => {
//     // This function remains unchanged...
//     const apiKey = process.env.GROQ_API_KEY;
//     if (!apiKey) throw new Error("GROQ_API_KEY is not set in environment variables.");

//     const model = new ChatGroq({
//         apiKey,
//         model: "meta-llama/llama-4-maverick-17b-128e-instruct",
//         temperature: 0.2,
//         maxRetries: 0
//     });

//     const promptTemplate = new PromptTemplate({
//         template: `You are an expert AI planner for a generalized web scraping system. Your task is to take a user's request and output a structured JSON plan.

//         Steps:
//         1. Analyze Intent: Understand the user’s explicit request AND infer the implicit, commonly expected details for that type of data. (Example: for jobs → company, role, salary, job description, apply link; for restaurants → name, address, rating, cuisine, contact; for products → title, price, brand, description, buy link).
//         2. Define Schema: Build a schema that covers both explicit fields requested by the user and reasonable implicit fields that users would expect for this type of query. Keep field names concise and consistent.
//         3. Generate Plan: Return a JSON object with two keys:
//         - searchApiQuery → A focused query for Google Search API that is broad enough to find reliable sources, but precise enough to target authoritative directories, review platforms, or relevant sites.
//         - extractionPrompt → A detailed instruction for extracting structured data from raw JSON/HTML. It must:
//             • List each field from the schema explicitly.
//             • Include both requested and inferred fields.
//             • Use "N/A" when a field is missing.
//             • Be reusable across varied website structures.

//         Rules:
//         - Output must be a valid JSON object only (no text or markdown).
//         - Always balance explicit user needs with implicit expectations for that domain.
//         - Ensure schema is suitable for tabular export (Excel/CSV).
//         - Field values should be clean, human-readable, and consistent.
//         - exclude LinkedIn from search
//         - exclude Reddit from search 
//         {format_instructions}

//         User’s request:
//         {prompt}`,
//         inputVariables: ["prompt"],
//         partialVariables: { format_instructions: planParser.getFormatInstructions() },
//     });

//     const chain = promptTemplate.pipe(model).pipe(planParser);

//     console.log("Invoking LangChain chain to generate plan...");
//     return await chain.invoke({ prompt: userPrompt });
// };


// // --- STAGE 2: GOOGLE SEARCH EXECUTION ---

// interface GoogleSearchItem { link: string; }

// // ** NECESSARY CHANGE 1: The function no longer caches search queries. It only handles rate limiting. **
// const findRelevantUrls = async (searchQuery: string, numResults = 2): Promise<string[]> => {
//     const apiKey = process.env.GOOGLE_API_KEY;
//     const cseId = process.env.GOOGLE_CSE_ID;
//     if (!apiKey || !cseId) throw new Error("Google API Key or CSE ID is not set.");

//     // Create a global, date-based key for the rate limit
//     const today = new Date().toISOString().split('T')[0]; // Gets date in YYYY-MM-DD format
//     const rateLimitKey = `google_api_limit:${today}`;
//     const DAILY_LIMIT = 90;

//     let allUrls: string[] = [];
//     const numRequests = Math.ceil(numResults / 10);
//     for (let i = 0; i < numRequests; i++) {
//         const currentUsage = await redis.incr(rateLimitKey);
//         if (currentUsage === 1) {
//             await redis.expire(rateLimitKey, 86400); // Set expiry on the first request of the day
//         }

//         if (currentUsage > DAILY_LIMIT) {
//             throw new Error("The application's daily Google Search API limit has been reached.");
//         }

//         const startIndex = i * 10 + 1;
//         const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(searchQuery)}&start=${startIndex}`;

//         try {
//             const response = await axios.get(url);
//             const items: GoogleSearchItem[] = response.data.items || [];
//             allUrls = allUrls.concat(items.map((item) => item.link));
//             if (items.length < 10) break;
//         } catch (error) {
//             await redis.decr(rateLimitKey); // Decrement if the API call failed
//             console.error(`Error fetching page ${i + 1} of Google Search results:`, error);
//             break;
//         }
//     }

//     return allUrls.slice(0, numResults);
// };


// // ** NECESSARY CHANGE 2: The scraper function no longer handles caching itself. **
// const scrapeFullPageContent = async (context: BrowserContext, url: string): Promise<string> => {
//     try {
//         console.log(`  > [LIVE SCRAPE] Scraping live content for: ${url}`);
//         const page = await context.newPage();
//         await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
//         const bodyText = await page.locator('body').innerText();
//         await page.close();
//         return bodyText;
//     } catch (error) {
//         return `Error scraping ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
//     }
// };


// const extractStructuredData = async (extractionPrompt: string, content: string) => {
//     // This function remains unchanged...
//     const apiKey = process.env.GROQ_API_KEY;
//     if (!apiKey) throw new Error("GROQ_API_KEY is not set in environment variables.");
//     const model = new ChatGroq({ apiKey, model: "meta-llama/llama-4-maverick-17b-128e-instruct", temperature: 0, maxRetries: 0 });
//     const promptTemplate = new PromptTemplate({
//         template: `{extraction_prompt}\n\nHere is the raw text to analyze:\n---\n{raw_content}\n---\nYour response must be ONLY the valid JSON data you have extracted.`,
//         inputVariables: ["extraction_prompt", "raw_content"],
//     });
//     const primaryParser = new JsonOutputParser();
//     const outputFixingParser = OutputFixingParser.fromLLM(model, primaryParser);
//     const chain = promptTemplate.pipe(model).pipe(outputFixingParser);
//     return await chain.invoke({ extraction_prompt: extractionPrompt, raw_content: content });
// };

// // --- MAIN API HANDLER ---

// export async function POST(req: Request) {
//     const { prompt } = await req.json();
//     if (!prompt) {
//         return NextResponse.json({ message: 'Prompt is required' }, { status: 400 });
//     }

//     let browser = null;

//     try {
//         // STAGE 1
//         const plan = await getPlanFromLLM(prompt);
//         console.log("Stage 1 complete. Generated plan:", plan);

//         // STAGE 2
//         // ** NECESSARY CHANGE: Call the function without the 'ip' argument **
//         const urls = await findRelevantUrls(plan.searchApiQuery);
//         const urlsToScrape = urls.slice(0, 5);
//         console.log(`Stage 2 complete. Found ${urls.length} URLs, scraping top ${urlsToScrape.length}.`);

//         browser = await chromium.launch({ headless: true });
//         const context = await browser.newContext({
//              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
//         });
//         const scrapedContents = await Promise.all(
//             urlsToScrape.map(url => scrapeFullPageContent(context, url))
//         );
//         const combinedContent = scrapedContents.join('\n\n---\n\n');

//         // STAGE 3
//         const structuredData = await extractStructuredData(plan.extractionPrompt, combinedContent);
//         console.log("Stage 3 complete. Extracted structured data:", structuredData);

//         return NextResponse.json({
//             plan,
//             structuredData
//         }, { status: 200 });

//     } catch (error: unknown) {
//         const errorMessage = error instanceof Error ? error.message : 'An unknown server error occurred';
//         if (errorMessage.includes("429") || errorMessage.includes("limit")) {
//             return NextResponse.json({ message: errorMessage }, { status: 429 });
//         }
//         console.error("Error in API handler:", error);
//         return NextResponse.json({ message: errorMessage }, { status: 500 });
//     } finally {
//         if (browser) {
//             await browser.close();
//         }
//     }
// }


import { NextResponse } from 'next/server';
import { ChatGroq } from "@langchain/groq";
import { JsonOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
import { OutputFixingParser } from "langchain/output_parsers";
import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import axios from 'axios';
import puppeteer, { Browser } from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { redis } from '../../../lib/redis';

// --- STAGE 1: AI PLANNER ---
const planSchema = z.object({
    searchApiQuery: z.string().describe("A highly optimized, single-line search query string to be used with a Google Search API."),
    extractionPrompt: z.string().describe("A detailed prompt for a different AI model that will run later to extract structured data from the raw search results according to the user's intent."),
});
type Plan = z.infer<typeof planSchema>;
const planParser = StructuredOutputParser.fromZodSchema(planSchema);

const getPlanFromLLM = async (userPrompt: string): Promise<Plan> => {
    console.log("Stage 1: Generating plan from LLM...");
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
        {prompt}`,
        inputVariables: ["prompt"],
        partialVariables: { format_instructions: planParser.getFormatInstructions() },
    });

    const chain = promptTemplate.pipe(model).pipe(planParser);
    const plan = await chain.invoke({ prompt: userPrompt });
    console.log("Stage 1: Plan generated:", plan);
    return plan;
};

// --- STAGE 2: URL FINDER & SCRAPER ---
interface GoogleSearchItem { link: string; }
const findRelevantUrls = async (numResults = 2, searchQuery: string): Promise<string[]> => {
    console.log("Stage 2: Fetching relevant URLs from Google...");
    const apiKey = process.env.GOOGLE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;
    if (!apiKey || !cseId) throw new Error("Google API Key or CSE ID is not set.");

    const today = new Date().toISOString().split('T')[0];
    const rateLimitKey = `google_api_limit:${today}`;
    const DAILY_LIMIT = 90;

    let allUrls: string[] = [];
    const numRequests = Math.ceil(numResults / 10);

    for (let i = 0; i < numRequests; i++) {
        const currentUsage = await redis.incr(rateLimitKey);
        if (currentUsage === 1) await redis.expire(rateLimitKey, 86400);
        if (currentUsage > DAILY_LIMIT) throw new Error("Daily Google Search API limit reached.");

        const startIndex = i * 10 + 1;
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(searchQuery)}&start=${startIndex}`;

        try {
            console.log(`Fetching Google Search page ${i + 1}...`);
            const response = await axios.get(url);
            const items: GoogleSearchItem[] = response.data.items || [];
            allUrls = allUrls.concat(items.map(item => item.link));
            if (items.length < 10) break;
        } catch (err) {
            await redis.decr(rateLimitKey);
            console.error(`Error fetching Google Search page ${i + 1}:`, err);
            break;
        }
    }

    console.log(`Stage 2: Found ${allUrls.length} URLs.`);
    return allUrls.slice(0, numResults);
};

const scrapeFullPageContent = async (browser: Browser, url: string): Promise<string> => {
    console.log(`Scraping URL: ${url}`);
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); // 45s timeout
        const bodyText = await page.evaluate(() => document.body.innerText);
        await page.close();
        console.log(`Scraping complete for URL: ${url}`);
        return bodyText;
    } catch (error) {
        console.error(`Error scraping URL ${url}:`, error);
        return `Error scraping ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
};

// --- STAGE 3: Structured Data Extraction ---
const extractStructuredData = async (extractionPrompt: string, content: string) => {
    console.log("Stage 3: Extracting structured data from content...");
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

    const model = new ChatGroq({ apiKey, model: "meta-llama/llama-4-maverick-17b-128e-instruct", temperature: 0, maxRetries: 0 });
    const promptTemplate = new PromptTemplate({
        template: `{extraction_prompt}\n\nHere is the raw text to analyze:\n---\n{raw_content}\n---\nYour response must be ONLY the valid JSON data you have extracted.`,
        inputVariables: ["extraction_prompt", "raw_content"],
    });

    const primaryParser = new JsonOutputParser();
    const outputFixingParser = OutputFixingParser.fromLLM(model, primaryParser);
    const chain = promptTemplate.pipe(model).pipe(outputFixingParser);

    const structuredData = await chain.invoke({ extraction_prompt: extractionPrompt, raw_content: content });
    console.log("Stage 3: Structured data extracted successfully.");
    return structuredData;
};

// --- MAIN API HANDLER ---
export async function POST(req: Request) {
    const { prompt } = await req.json();
    if (!prompt) {
        return NextResponse.json({ message: 'Prompt is required' }, { status: 400 });
    }

    let browser: Browser | null = null;

    try {
        const plan = await getPlanFromLLM(prompt);

        const urls = await findRelevantUrls(2, plan.searchApiQuery);
        const urlsToScrape = urls.slice(0, 2);
        console.log(`Preparing to scrape top ${urlsToScrape.length} URLs:`, urlsToScrape);

        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: true,
        });

        const scrapedContents: string[] = [];
        for (const url of urlsToScrape) {
            const content = await scrapeFullPageContent(browser, url);
            scrapedContents.push(content);
        }

        const combinedContent = scrapedContents.join('\n\n---\n\n');
        console.log("All URLs scraped. Combined content length:", combinedContent.length);

        const structuredData = await extractStructuredData(plan.extractionPrompt, combinedContent);

        return NextResponse.json({ plan, structuredData }, { status: 200 });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown server error';
        console.error("API Handler Error:", errorMessage);
        if (errorMessage.includes("429") || errorMessage.includes("limit")) {
            return NextResponse.json({ message: errorMessage }, { status: 429 });
        }
        return NextResponse.json({ message: errorMessage }, { status: 500 });
    } finally {
        if (browser) {
            console.log("Closing browser...");
            await browser.close();
        }
    }
}


