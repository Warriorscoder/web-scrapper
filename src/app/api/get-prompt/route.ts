import { NextResponse } from 'next/server';
import { ChatGroq } from "@langchain/groq";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { OutputFixingParser } from "langchain/output_parsers";
import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import axios from 'axios';
import puppeteer, { Browser, ElementHandle, Page } from "puppeteer";
import chromium from "@sparticuz/chromium";
import { redis } from '../../../lib/redis';

// =================== HELPERS ===================
const getSecondsUntilMidnight = (): number => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return Math.floor((midnight.getTime() - now.getTime()) / 1000);
};

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// Updated chunkContents to handle raw string contents
function chunkContents(
    contents: { url: string; content: string }[],
    maxTokens = 3500
): { url: string; content: string }[][] {
    const chunks: { url: string; content: string }[][] = [];
    let currentChunk: { url: string; content: string }[] = [];
    let currentTokens = 0;

    for (const item of contents) {
        const itemTokens = estimateTokens(item.content);

        if (currentTokens + itemTokens > maxTokens && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(item);
        currentTokens += itemTokens;
    }

    if (currentChunk.length > 0) chunks.push(currentChunk);
    return chunks;
}

// =================== STAGE 1: AI PLANNER ===================
const planSchema = z.object({
    searchApiQuery: z.string(),
    extractionPrompt: z.string(),
});
type Plan = z.infer<typeof planSchema>;

const getPlanFromLLM = async (userPrompt: string): Promise<Plan> => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

    const model = new ChatGroq({
        apiKey,
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0.2,
    });

    const promptTemplate = new PromptTemplate({
        template: `You are an expert AI planner for a web scraping system focused on JOB SEARCH and EMPLOYMENT DATA. Your task is to take a user's request and output a structured JSON plan.

        Steps:
        1. Analyze Intent: Understand the user’s explicit request AND infer implicit, commonly expected details for job-related data.  
        (Example: for jobs → job_title, company_name, location, salary_range, job_description, skills_required, experience_level, education_requirement, job_type (full-time/part-time/remote), posted_date, apply_link, source_website.)

        2. Define Schema: Build a schema that includes both the fields explicitly requested by the user and the implicit standard fields for job data.  
        Field names must be concise, lowercase, and consistent.

        3. Generate Plan: Return a JSON object with two keys:
        - searchApiQuery → A focused query for Google Search API that finds reliable job listings or aggregators, while excluding unauthorized or restricted domains.
        - extractionPrompt → A detailed instruction for extracting structured job listing data from raw HTML or JSON. It must:
            • List each field from the schema explicitly.  
            • Include both requested and inferred fields.  
            • Use "N/A" when a field is missing.  
            • Be reusable across multiple website structures.

        Rules:
        - Output must be a valid JSON object only (no text or markdown).
        - Schema must be suitable for tabular export (Excel/CSV).
        - Values must be human-readable, clean, and consistent.
        - Strictly exclude the following sources from search or extraction:
        - Stricly check the date of the job posting to ensure it is posted      today or yesterday not older than that .
        

        - Also exclude Reddit from search results.

        {format_instructions}

        User’s request:
        {prompt}
        `,
        inputVariables: ["prompt"],
        partialVariables: { format_instructions: `{"searchApiQuery": "...", "extractionPrompt": "..."}` },
    });

    const chain = promptTemplate.pipe(model).pipe(new JsonOutputParser());
    const plan = await chain.invoke({ prompt: userPrompt });
    return plan as Plan;
};

// =================== STAGE 2: URL FETCHER ===================
const findRelevantUrls = async (numResults = 3, searchQuery: string): Promise<string[]> => {
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
        try { cachedUrls = JSON.parse(cachedData); } catch { cachedUrls = []; }
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
            const response = await axios.get(url);
            const items = response.data.items || [];
            const newUrls = items.map((item: string) => item.link);
            allUrls.push(...newUrls);
            await redis.set(urlsKey, JSON.stringify(allUrls), { ex: getSecondsUntilMidnight() });
            if (items.length < 10) break;
        } catch { await redis.decr(rateLimitKey); break; }
    }
    console.log(`[URL Fetcher] Retrieved ${allUrls.slice(0, numResults)} URLs for query: "${searchQuery}"`);
    return allUrls.slice(0, numResults);
};

// =================== STAGE 2b: SCRAPER ===================
interface PuppeteerPage extends Page {
    $x(xpath: string): Promise<ElementHandle<Element>[]>;
    waitForTimeout(ms: number): Promise<void>;
}

// =================== STAGE 3: EXTRACTION ===================

const scrapeFullPageContent = async (browser: Browser, url: string): Promise<string> => {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
  );

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("body", { timeout: 20000 }).catch(() => null);

    // Extract job-related content specifically
    const rawJobText = await page.evaluate(() => {
      const getText = (selector: string) => {
        const el = document.querySelector(selector);
        return el ? el.textContent?.trim() || "" : "";
      };

      const findByText = (regex: RegExp): string => {
        const el = Array.from(document.querySelectorAll("body *"))
          .find((e) => regex.test(e.textContent || ""));
        return el ? el.textContent?.trim() || "" : "";
      };

      const parts: string[] = [];

      // Capture likely job fields
      const jobTitle = getText("h1") || getText("[data-test='jobTitle']") || findByText(/job title|position/i);
      const company = getText(".company") || findByText(/company|employer/i);
      const location = getText(".location") || findByText(/location|city|remote/i);
      const salary = findByText(/\$|₹|€|£|salary|per year|per hour/i);
      const experience = findByText(/experience|years|entry level|junior|senior|mid/i);
      const jobType = findByText(/full[- ]?time|part[- ]?time|contract|remote|hybrid/i);
      const posted = findByText(/posted|days ago|hours ago|today|yesterday/i);
      const applyLink = (document.querySelector("a[href*='apply']") as HTMLAnchorElement)?.href || "";
      const description = findByText(/responsibilit|requirement|description|role/i);

      // Add to text parts (skip empty ones)
      [jobTitle, company, location, salary, experience, jobType, posted, description, applyLink]
        .filter(Boolean)
        .forEach((t) => parts.push(t));

      // Also include the full visible text for context
      const bodyText = document.body?.innerText?.trim() || "";
      parts.push(bodyText);

      // Join everything into one unstructured blob
      return parts.join("\n\n").trim();
    });

    console.log(`[Scraper] ✅ Extracted unstructured job text for ${url} (${rawJobText.length} chars)`);

    return rawJobText;
  } catch (error) {
    console.error(`[Scraper] ❌ Failed to scrape ${url}:`, error);
    return "";
  } finally {
    await page.close();
  }
};


const extractStructuredData = async (
  extractionPrompt: string,
  contents: { url: string; content: string }[]
): Promise<unknown[]> => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

  const model = new ChatGroq({
    apiKey,
    model: "meta-llama/llama-4-maverick-17b-128e-instruct",
    temperature: 0,
  });

  const promptTemplate = new PromptTemplate({
    template: `{extraction_prompt}\n\nHere are raw scraped pages:\n{raw_content}\n\nReturn ONLY valid JSON array.`,
    inputVariables: ["extraction_prompt", "raw_content"],
  });

  const primaryParser = new JsonOutputParser();
  const outputFixingParser = OutputFixingParser.fromLLM(model, primaryParser);
  const chain = promptTemplate.pipe(model).pipe(outputFixingParser);

  // ✅ reduce max token size to stay under Groq limit (safe ~1500 tokens per chunk)
  const chunks = chunkContents(contents, 1500);

  const allResults: unknown[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const rawContent = chunk
      .map(c => `URL: ${c.url}\nContent:\n${c.content}`)
      .join("\n\n---\n\n");

    console.log(`[Extractor] Processing chunk ${i + 1}/${chunks.length} (${rawContent.length} chars)`);

    try {
      const result = await chain.invoke({
        extraction_prompt: extractionPrompt,
        raw_content: rawContent.slice(0, 10000), // hard limit content size
      });

      if (result) {
        allResults.push(result);
        console.log(`[Extractor] ✅ Completed chunk ${i + 1}`);
      }
    } catch (error) {
      console.error(`[Extractor] ❌ Failed chunk ${i + 1}`, error);
      allResults.push({ error: `Failed to process chunk ${i + 1}` });

      // ✅ Break if model rejects large input repeatedly
      if (error instanceof Error && error.message.includes("Request too large")) {
        console.warn("[Extractor] ⚠️ Aborting further chunks due to request size limit.");
        break;
      }
    }
  }

  console.log(`[Extractor] ✅ Finished all ${allResults.length} chunks.`);
  return allResults.flat(); // flatten nested arrays if model returns JSON arrays
};


// =================== MAIN API HANDLER ===================
export async function POST(req: Request) {
    console.log("[API] POST /get-prompt called");

    const { prompt } = await req.json();
    console.log("[API] User prompt received:", prompt);

    if (!prompt) {
        console.warn("[API] No prompt provided");
        return NextResponse.json({ message: 'Prompt is required' }, { status: 400 });
    }

    let browser: Browser | null = null;
    const exicutablePath = process.env.EXICUTABLE_PATH
    try {
        console.log("[API] Generating plan from LLM...");
        const plan = await getPlanFromLLM(prompt);

        console.log("[API] Fetching relevant URLs...");
        const urls = await findRelevantUrls(3, plan.searchApiQuery);

        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: exicutablePath || await chromium.executablePath(),
            headless: true,
        });

        const scrapedContents: { url: string; content: string }[] = [];

        for (const url of urls) {
            const cacheKey = `scraped:${url}`;
            const cached = await redis.get(cacheKey);

            let content: string;
            if (typeof cached === "string") {
                content = cached;
            } else {
                content = await scrapeFullPageContent(browser, url);
                await redis.set(cacheKey, content, { ex: getSecondsUntilMidnight() });
            }

            scrapedContents.push({ url, content });
        }

        const structuredData = await extractStructuredData(plan.extractionPrompt, scrapedContents);
        console.log("[API] Extraction complete, sending response.", structuredData);
        return NextResponse.json({ plan, structuredData }, { status: 200 });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown server error';
        return NextResponse.json({ message: errorMessage }, { status: 500 });

    } finally {
        if (browser) await browser.close();
    }
}
