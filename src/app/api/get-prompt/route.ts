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

export interface ScrapedPage {
    job_title: string | null;
    company_name: string | null;
    location: string | null;
    job_type: string | null;
    work_mode: string | null;
    salary_range: string | null;
    experience_level: string | null;
    skills_required: string | null;
    job_description: string | null;
    posted_date: string | null;
    apply_link: string | null;
    industry: string | null;
    education_requirement: string | null;
    source_website: string;
    error?: string;
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function chunkContents(
    contents: { url: string; content: ScrapedPage }[],
    maxTokens = 3500
): { url: string; content: ScrapedPage }[][] {
    const chunks: { url: string; content: ScrapedPage }[][] = [];
    let currentChunk: { url: string; content: ScrapedPage }[] = [];
    let currentTokens = 0;

    for (const item of contents) {
        const itemText = `URL: ${item.url}
Job Title: ${item.content.job_title}
Company: ${item.content.company_name}
Location: ${item.content.location}
Type: ${item.content.job_type}
Work Mode: ${item.content.work_mode}
Salary: ${item.content.salary_range}
Experience: ${item.content.experience_level}
Skills: ${item.content.skills_required}
Description: ${item.content.job_description}
Posted Date: ${item.content.posted_date}
Apply Link: ${item.content.apply_link}`;

        const itemTokens = estimateTokens(itemText);

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

        **Exclude List (no scraping / automated extraction):**
        naukri.com, linkedin.com, timesjobs.com, shine.com, indeed.com, freshersworld.com, internshala.com, quikr.com, wisdomjobs.com, monsterindia.com, foundit.in, careerbuilder.co.in, iimjobs.com, glassdoor.co.in, apna.co, angel.co, workindia.in, greenjobs.oorzo.co, jobtrendsindia.com, evermorejobs.com, maxjobs.in, thejobzilla.com

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
const findRelevantUrls = async (numResults = 5, searchQuery: string): Promise<string[]> => {
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

    return allUrls.slice(0, numResults);
};

// =================== STAGE 2b: SCRAPER ===================
interface PuppeteerPage extends Page {
    $x(xpath: string): Promise<ElementHandle<Element>[]>;
    waitForTimeout(ms: number): Promise<void>;
}

const scrapeFullPageContent = async (browser: Browser, url: string): Promise<ScrapedPage> => {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36");
    const p = page as PuppeteerPage;

    try {
        await p.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await p.waitForSelector("body", { timeout: 20000 }).catch(() => null);

        const expandButtons = await p.$x("//button[contains(., 'Read more') or contains(., 'Show more')]");
        if (expandButtons.length > 0) { await expandButtons[0].click(); await p.waitForTimeout(1500); }

        const data: ScrapedPage = await p.evaluate(() => {
            const getText = (selector: string): string | null => document.querySelector(selector)?.textContent?.trim() || null;
            const getByKeywords = (keywords: string[]): string | null => {
                const allElements = Array.from(document.querySelectorAll("body *")).filter(el => el.textContent && el.textContent.trim().length < 300);
                for (const el of allElements) { const text = el.textContent?.trim().toLowerCase() || ""; if (keywords.some(k => text.includes(k))) return el.textContent?.trim() || null; }
                return null;
            };
            const getJobDescription = (): string | null => {
                const desc = document.querySelector("section.job-description, div.job-description, .description, #jobDescriptionText");
                if (desc) return desc.textContent?.trim() || null;
                const text = document.body.innerText;
                const match = text.match(/(Responsibilities|Description|Duties|Overview)[\s\S]{100,}/i);
                return match ? match[0].trim() : null;
            };
            const getApplyLink = (): string | null => {
                const linkEl = Array.from(document.querySelectorAll("a, button")).find(el => /apply/i.test(el.textContent || ""));
                if (!linkEl) return null;
                if (linkEl instanceof HTMLAnchorElement && linkEl.href) return linkEl.href;
                return linkEl.getAttribute("data-url") || linkEl.getAttribute("onclick") || null;
            };

            return {
                job_title: getText("h1"),
                company_name: getByKeywords(["company", "employer", "organization", "hiring"]),
                location: getByKeywords(["location", "remote", "hybrid", "on-site", "city", "state"]),
                job_type: getByKeywords(["full-time", "part-time", "internship", "contract"]),
                work_mode: getByKeywords(["remote", "hybrid", "on-site"]),
                salary_range: getByKeywords(["salary", "pay", "compensation", "package"]),
                experience_level: getByKeywords(["junior", "senior", "mid-level", "entry", "lead"]),
                skills_required: getByKeywords(["skills", "technologies", "requirements", "proficient"]),
                job_description: getJobDescription(),
                posted_date: getByKeywords(["posted", "date", "updated"]),
                apply_link: getApplyLink(),
                industry: getByKeywords(["industry", "sector", "field"]),
                education_requirement: getByKeywords(["education", "degree", "qualification"]),
                source_website: window.location.hostname,
            };
        });

        await p.close();
        return data;

    } catch (_error) {
        await p.close();
        return {
            job_title: null, company_name: null, location: null, job_type: null, work_mode: null,
            salary_range: null, experience_level: null, skills_required: null, job_description: null,
            posted_date: null, apply_link: null, industry: null, education_requirement: null,
            source_website: new URL(url).hostname, error: "Scraping failed",
        };
    }
};



// =================== STAGE 3: EXTRACTION ===================
const extractStructuredData = async (
    extractionPrompt: string,
    contents: { url: string; content: ScrapedPage }[]
): Promise<unknown[]> => {
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

    const chunks = chunkContents(contents, 1800);
    const allResults: unknown[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const rawContent = chunks[i].map(c =>
            `URL: ${c.url}
Job Title: ${c.content.job_title}
Company: ${c.content.company_name}
Location: ${c.content.location}
Type: ${c.content.job_type}
Work Mode: ${c.content.work_mode}
Salary: ${c.content.salary_range}
Experience: ${c.content.experience_level}
Skills: ${c.content.skills_required}
Description: ${c.content.job_description}
Posted Date: ${c.content.posted_date}
Apply Link: ${c.content.apply_link}`
        ).join("\n\n---\n\n");

        try { allResults.push(await chain.invoke({ extraction_prompt: extractionPrompt, raw_content: rawContent })); }
        catch { allResults.push({ error: `Failed to process chunk ${i + 1}` }); }
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
            if (typeof cached === "string") content = JSON.parse(cached);
            else {
                content = await scrapeFullPageContent(browser, url);
                await redis.set(cacheKey, JSON.stringify(content), { ex: getSecondsUntilMidnight() });
            }

            scrapedContents.push({ url, content });
        }

        const structuredData = await extractStructuredData(plan.extractionPrompt, scrapedContents);
        return NextResponse.json({ plan, structuredData }, { status: 200 });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown server error';
        return NextResponse.json({ message: errorMessage }, { status: 500 });
    } finally {
        if (browser) await browser.close();
    }
}
