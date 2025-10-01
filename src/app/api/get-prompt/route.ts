import { NextResponse } from 'next/server';
import { ChatGroq } from "@langchain/groq";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { OutputFixingParser } from "langchain/output_parsers";
import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import axios from 'axios';
import puppeteer, { Browser } from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { redis } from '../../../lib/redis';

// =================== HELPERS ===================

// Redis expiry until midnight
const getSecondsUntilMidnight = (): number => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return Math.floor((midnight.getTime() - now.getTime()) / 1000);
};

interface ScrapedPage {
    title: string | null;
    metaDescription: string | null;
    h1: string[];
    h2: string[];
    links: string[];
    bodyText: string;
    error?: string;
}

// Rough token estimator (~4 chars per token avg)
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// Split contents into chunks under token limit
function chunkContents(
    contents: { url: string; content: ScrapedPage }[],
    maxTokens = 3500
): { url: string; content: ScrapedPage }[][] {
    const chunks: { url: string; content: ScrapedPage }[][] = [];
    let currentChunk: { url: string; content: ScrapedPage }[] = [];
    let currentTokens = 0;

    for (const item of contents) {
        const itemText = `URL: ${item.url}\nTITLE: ${item.content.title}\nMETA: ${item.content.metaDescription}\nTEXT: ${item.content.bodyText}`;
        const itemTokens = estimateTokens(itemText);

        if (currentTokens + itemTokens > maxTokens && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(item);
        currentTokens += itemTokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

// =================== STAGE 1: AI PLANNER ===================
const planSchema = z.object({
    searchApiQuery: z.string(),
    extractionPrompt: z.string(),
});
type Plan = z.infer<typeof planSchema>;

const getPlanFromLLM = async (userPrompt: string): Promise<Plan> => {
    console.log("Stage 1: Generating plan from LLM...");
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

    const model = new ChatGroq({
        apiKey,
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0.2,
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
        partialVariables: { format_instructions: `{"searchApiQuery": "...", "extractionPrompt": "..."}` },
    });

    const chain = promptTemplate.pipe(model).pipe(new JsonOutputParser());
    const plan = await chain.invoke({ prompt: userPrompt });
    console.log("Stage 1: Plan generated:", plan);
    return plan as Plan;
};

// =================== STAGE 2: URL FETCHER ===================
interface GoogleSearchItem { link: string; }

const findRelevantUrls = async (numResults = 5, searchQuery: string): Promise<string[]> => {
    console.log("Stage 2: Fetching URLs...");
    const apiKey = process.env.GOOGLE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;
    if (!apiKey || !cseId) throw new Error("Google API Key or CSE ID missing.");

    const today = new Date().toISOString().split('T')[0];
    const rateLimitKey = `google_api_limit:${today}`;
    const urlsKey = `scraped_urls:${today}`;
    const DAILY_LIMIT = 90;

    const cachedData = await redis.get(urlsKey);
    let cachedUrls: string[] = [];
    if (cachedData && typeof cachedData === "string") {
        try {
            cachedUrls = JSON.parse(cachedData);
            console.log("Stage 2: Loaded cached URLs:", cachedUrls);
        } catch {
            cachedUrls = [];
        }
    }

    const allUrls: string[] = [...cachedUrls];
    const numRequests = Math.ceil(numResults / 10);

    for (let i = 0; i < numRequests && allUrls.length < numResults; i++) {
        const currentUsage = await redis.incr(rateLimitKey);
        if (currentUsage === 1) await redis.expire(rateLimitKey, 86400);
        if (currentUsage > DAILY_LIMIT) throw new Error("Daily Google API limit reached.");

        const startIndex = i * 10 + 1;
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(searchQuery)}&start=${startIndex}`;

        try {
            console.log(`Fetching Google Search page ${i + 1}...`);
            const response = await axios.get(url);
            const items: GoogleSearchItem[] = response.data.items || [];
            const newUrls = items.map(item => item.link);
            allUrls.push(...newUrls);

            await redis.set(urlsKey, JSON.stringify(allUrls), { ex: getSecondsUntilMidnight() });
            if (items.length < 10) break;
        } catch (err) {
            await redis.decr(rateLimitKey);
            console.error(`Error fetching Google Search page ${i + 1}:`, err);
            break;
        }
    }

    console.log(`Stage 2: Found total ${allUrls.length} URLs`);
    return allUrls.slice(0, numResults);
};

// =================== STAGE 2b: SCRAPER ===================
const scrapeFullPageContent = async (browser: Browser, url: string): Promise<ScrapedPage> => {
    console.log(`Stage 2b: Scraping URL: ${url}`);
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

        const data = await page.evaluate(() => {
            const getText = (selector: string): string[] =>
                Array.from(document.querySelectorAll(selector)).map(el => el.textContent?.trim() || "");

            return {
                title: document.title || null,
                metaDescription: document.querySelector("meta[name='description']")?.getAttribute("content") || null,
                h1: getText("h1"),
                h2: getText("h2"),
                links: Array.from(document.querySelectorAll("a")).map(a => (a as HTMLAnchorElement).href),
                bodyText: document.body.innerText || "",
            };
        });

        await page.close();
        return data;
    } catch (error) {
        console.error(`Error scraping ${url}:`, error);
        return { title: null, metaDescription: null, h1: [], h2: [], links: [], bodyText: "", error: "Scraping failed" };
    }
};

// =================== STAGE 3: EXTRACTION (CHUNKED) ===================
const extractStructuredData = async (
    extractionPrompt: string,
    contents: { url: string; content: ScrapedPage }[]
): Promise<unknown[]> => {
    console.log("Stage 3: Extracting structured data with LLM (chunked)...");
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

    const model = new ChatGroq({ apiKey, model: "meta-llama/llama-4-maverick-17b-128e-instruct", temperature: 0 });

    const promptTemplate = new PromptTemplate({
        template: `{extraction_prompt}\n\nHere are scraped pages:\n{raw_content}\n\nReturn ONLY valid JSON.`,
        inputVariables: ["extraction_prompt", "raw_content"],
    });

    const primaryParser = new JsonOutputParser();
    const outputFixingParser = OutputFixingParser.fromLLM(model, primaryParser);
    const chain = promptTemplate.pipe(model).pipe(outputFixingParser);

    const chunks = chunkContents(contents, 3500);
    console.log(`Stage 3: Split into ${chunks.length} chunk(s)`);

    const allResults: unknown[] = [];

    for (let i = 0; i < chunks.length; i++) {
        console.log(`Stage 3: Processing chunk ${i + 1}/${chunks.length}`);

        const rawContent = chunks[i]
            .map(c => `URL: ${c.url}\nTITLE: ${c.content.title}\nMETA: ${c.content.metaDescription}\nTEXT: ${c.content.bodyText}`)
            .join("\n\n---\n\n");

        try {
            const result = await chain.invoke({ extraction_prompt: extractionPrompt, raw_content: rawContent });
            allResults.push(result);
        } catch (err) {
            console.error(`Stage 3: Error in chunk ${i + 1}`, err);
            allResults.push({ error: `Failed to process chunk ${i + 1}` });
        }
    }

    return allResults;
};

// =================== MAIN API HANDLER ===================
export async function POST(req: Request) {
    const { prompt } = await req.json();
    if (!prompt) return NextResponse.json({ message: 'Prompt is required' }, { status: 400 });

    let browser: Browser | null = null;

    try {
        const plan = await getPlanFromLLM(prompt);

        const urls = await findRelevantUrls(5, plan.searchApiQuery);
        console.log("Stage 2: Final URLs to process:", urls);

        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: true,
        });

        const scrapedContents: { url: string; content: ScrapedPage }[] = [];
        for (const url of urls) {
            const cacheKey = `scraped:${url}`;
            const cached = await redis.get(cacheKey);

            let content: ScrapedPage;
            if (typeof cached === "string") {
                console.log(`Stage 2b: Using cached data for ${url}`);
                content = JSON.parse(cached);
            } else {
                console.log(`Stage 2b: Scraping fresh data for ${url}`);
                content = await scrapeFullPageContent(browser, url);
                await redis.set(cacheKey, JSON.stringify(content), { ex: getSecondsUntilMidnight() });
                console.log(`Stage 2b: Cached new data for ${url}`);
            }
            scrapedContents.push({ url, content });
        }

        const structuredData = await extractStructuredData(plan.extractionPrompt, scrapedContents);

        console.log("Stage 3: Extraction completed.");
        return NextResponse.json({ plan, structuredData }, { status: 200 });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown server error';
        console.error("API Handler Error:", errorMessage);
        return NextResponse.json({ message: errorMessage }, { status: 500 });
    } finally {
        if (browser) await browser.close();
    }
}
