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

// ======================================================================
//  SANITIZATION UTIL (🔥 NEW & STRONG)
// ======================================================================
function sanitize(input: string): string {
  if (!input) return "";

  return input
    .replace(/[\u0000-\u001F\u007F]/g, "")        // Remove control chars
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")                         // Normalize spaces
    .replace(/\\/g, "\\\\")                       // Escape backslashes
    .replace(/"/g, '\\"')                         // Escape quotes
    .trim();
}

// ======================================================================
//  HELPERS
// ======================================================================
const getSecondsUntilMidnight = (): number => {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.floor((midnight.getTime() - now.getTime()) / 1000);
};

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function chunkContents(
  contents: { url: string; content: string }[],
  maxTokens = 1500
): { url: string; content: string }[][] {
  const chunks: { url: string; content: string }[][] = [];
  let currentChunk: { url: string; content: string }[] = [];
  let currentTokens = 0;

  for (const item of contents) {
    const tokens = estimateTokens(item.content);

    if (currentTokens + tokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(item);
    currentTokens += tokens;
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

// ======================================================================
//  STAGE 1 — AI PLANNER
// ======================================================================
const planSchema = z.object({
  searchApiQuery: z.string(),
  extractionPrompt: z.string(),
});
type Plan = z.infer<typeof planSchema>;

const getPlanFromLLM = async (userPrompt: string): Promise<Plan> => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is missing.");

  const model = new ChatGroq({
    apiKey,
    model: "meta-llama/llama-4-maverick-17b-128e-instruct",
    temperature: 0.2,
  });

  const promptTemplate = new PromptTemplate({
    template: process.env.PROMPT_MARKETING!,
    inputVariables: ["prompt"],
    partialVariables: {
      format_instructions: `{"searchApiQuery":"...", "extractionPrompt":"..."}`,
    },
  });

  const chain = promptTemplate.pipe(model).pipe(new JsonOutputParser());
  const plan = await chain.invoke({ prompt: userPrompt });
  return plan as Plan;
};

// ======================================================================
//  STAGE 2 — GOOGLE URL FINDER
// ======================================================================
interface GoogleSearchItem {
  link: string;
}

const findRelevantUrls = async (
  numResults = 3,
  searchQuery: string
): Promise<string[]> => {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cseId) throw new Error("Missing Google API Keys.");

  const today = new Date().toISOString().split("T")[0];
  const rateLimitKey = `google_api_limit:${today}`;
  const urlsKey = `scraped_urls:${today}`;
  const DAILY_LIMIT = 100;

  // Cache handling
  const cachedData = await redis.get(urlsKey);
  let cachedUrls: string[] = [];

  if (typeof cachedData === "string") {
    try {
      cachedUrls = JSON.parse(cachedData) as string[];
    } catch {
      cachedUrls = [];
    }
  }

  const allUrls: string[] = [...cachedUrls];
  const numRequests = Math.ceil(numResults / 10);

  for (let i = 0; i < numRequests && allUrls.length < numResults; i++) {
    const usage = await redis.incr(rateLimitKey);
    if (usage === 1) await redis.expire(rateLimitKey, 86400);

    if (usage > DAILY_LIMIT) throw new Error("Daily Google API limit reached.");

    const startIndex = i * 10 + 1;

    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(
      searchQuery
    )}&start=${startIndex}`;

    try {
      const response = await axios.get(url);

      const items: GoogleSearchItem[] = Array.isArray(response.data.items)
        ? response.data.items
        : [];

      const newUrls = items.map((item) => item.link);

      allUrls.push(...newUrls);
      await redis.set(urlsKey, JSON.stringify(allUrls), {
        ex: getSecondsUntilMidnight(),
      });

      if (items.length < 10) break;
    } catch {
      await redis.decr(rateLimitKey);
      break;
    }
  }

  const finalUrls = allUrls.slice(0, numResults);
  console.log(`[URL Fetcher] Retrieved URLs:`, finalUrls);

  return finalUrls;
};


// ======================================================================
//  STAGE 2B — NEW GENERALIZED SCRAPER
//  Works for BOTH person pages (LinkedIn, About pages)
//  AND companies (cafes, shops, startups, founders, HR, etc.)
// ======================================================================
const scrapeFullPageContent = async (browser: Browser, url: string): Promise<string> => {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
  );

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    await page.waitForSelector("body", { timeout: 15000 }).catch(() => null);

    const raw = await page.evaluate(() => {
      const parts: string[] = [];

      const extract = (regex: RegExp) =>
        Array.from(document.body.querySelectorAll("*"))
          .map((el) => el.textContent?.trim() || "")
          .find((t) => regex.test(t)) || "";

      // Person / Founder / HR / CEO / Manager names
      const personName =
        extract(/founder|owner|ceo|hr|manager|director|team|about/i) ||
        document.querySelector("h1,h2,h3")?.textContent?.trim() ||
        "";

      // Emails
      const email = extract(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);

      // Phones
      const phone = extract(/(\+?\d[\d\-\s]{7,14}\d)/);

      // Address & location
      const address = extract(/road|street|sector|block|nagar|india|address|location/i);

      // Company name
      const company =
        extract(/cafe|company|studio|agency|pvt|ltd|restaurant|shop|boutique/i) ||
        document.querySelector("title")?.textContent?.trim() ||
        "";

      // Social links
      const links = Array.from(document.querySelectorAll("a"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) =>
          /instagram|facebook|linkedin|twitter|website|about/i.test(h)
        );

      const allText = document.body.innerText || "";

      parts.push(
        personName,
        email,
        phone,
        address,
        company,
        links.join("\n"),
        allText
      );

      return parts.join("\n\n").trim();
    });

    const cleaned = sanitize(raw);
    console.log(`[Scraper] Cleaned content length: ${cleaned.length} for ${url}`);

    return cleaned;
  } catch (err) {
    console.error(`[Scraper] Failed for ${url}`, err);
    return "";
  } finally {
    await page.close();
  }
};

// ======================================================================
//  STAGE 3 — STRUCTURED DATA EXTRACTOR
// ======================================================================
const extractStructuredData = async (
  extractionPrompt: string,
  contents: { url: string; content: string }[]
): Promise<unknown[]> => {
  const apiKey = process.env.GROQ_API_KEY!;
  const model = new ChatGroq({
    apiKey,
    model: "meta-llama/llama-4-maverick-17b-128e-instruct",
    temperature: 0,
  });

  const template = `
{extraction_prompt}

Here are raw scraped pages:
"""
{raw_content}
"""

Return ONLY valid JSON array.
`;

  const promptTemplate = new PromptTemplate({
    template,
    inputVariables: ["extraction_prompt", "raw_content"],
  });

  const primary = new JsonOutputParser();
  const fixed = OutputFixingParser.fromLLM(model, primary);
  const chain = promptTemplate.pipe(model).pipe(fixed);

  const chunks = chunkContents(contents, 1500);

  const results: unknown[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const content = chunk
      .map((c) => `URL: ${c.url}\nContent:\n${sanitize(c.content)}`)
      .join("\n\n---\n\n");

    console.log(`[Extractor] Processing chunk ${i + 1}/${chunks.length}`);

    try {
      const res = await chain.invoke({
        extraction_prompt: extractionPrompt,
        raw_content: content.slice(0, 10000),
      });

      if (res) results.push(res);
    } catch (err) {
      console.error(`[Extractor] Failed chunk ${i + 1}`, err);
      results.push([]);
    }
  }

  return results.flat();
};

// ======================================================================
//  MAIN HANDLER
// ======================================================================
interface ScrapedContent {
  url: string;
  content: string;
}

interface ExtractedRecord {
  [key: string]: unknown;
}

export async function POST(req: Request) {
  console.log("[API] POST /get-prompt");

  const body = await req.json();
  const prompt: string = body.prompt;

  if (!prompt) {
    return NextResponse.json(
      { message: "Prompt required" },
      { status: 400 }
    );
  }

  let browser: Browser | null = null;

  try {
    console.log("[API] Creating plan...");
    const plan = await getPlanFromLLM(prompt);

    console.log("[API] Searching URLs...");
    const urls = await findRelevantUrls(3, plan.searchApiQuery);

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath:
        process.env.EXICUTABLE_PATH || (await chromium.executablePath()),
      headless: true,
    });

    const scrapedContents: ScrapedContent[] = [];

    for (const url of urls) {
      const cacheKey = `scraped:${url}`;
      const cached = await redis.get(cacheKey);

      let content: string;

      if (typeof cached === "string") {
        content = cached;
      } else {
        const scraped = await scrapeFullPageContent(browser, url);
        content = scraped;
        await redis.set(cacheKey, content, {
          ex: getSecondsUntilMidnight(),
        });
      }

      scrapedContents.push({ url, content });
    }

    // Extraction
    const structuredData = await extractStructuredData(
      plan.extractionPrompt,
      scrapedContents
    );

    // Force typed array
    const flatData: ExtractedRecord[] = Array.isArray(structuredData)
      ? structuredData.flatMap((item) =>
          typeof item === "object" && item !== null ? [item as ExtractedRecord] : []
        )
      : [];

    console.log("[API] Final structuredData:", flatData);

    return NextResponse.json(
      { plan, structuredData: flatData },
      { status: 200 }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown server error";

    console.error("FATAL ERROR:", err);

    return NextResponse.json({ message }, { status: 500 });
  } finally {
    if (browser) await browser.close();
  }
}
