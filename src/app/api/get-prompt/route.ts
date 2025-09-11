// import { NextResponse } from 'next/server';
// import { ChatGroq } from "@langchain/groq";
// import { StructuredOutputParser } from "@langchain/core/output_parsers";
// import { PromptTemplate } from "@langchain/core/prompts";
// import { z } from "zod";

// // This is a DUMMY tool that simulates calling a Google Search API.
// const callGoogleSearchApiTool = async (searchQuery: string): Promise<string> => {
//     console.log(`--- DUMMY TOOL: Calling Google Search API with query ---`);
//     console.log(searchQuery);
//     await new Promise(resolve => setTimeout(resolve, 1000));
//     console.log("--- DUMMY TOOL: Returning fake raw search results ---");
//     return `
//         Job Title: Senior Frontend Engineer (TypeScript), Company: Vercel, Location: Remote (US), Posted: 2 days ago...
//         ---
//         Stripe is hiring a Staff Software Engineer with deep TypeScript knowledge. Salary: $180,000 - $250,000...
//         ---
//         Position: Software Developer at a stealth startup. We use TypeScript and GraphQL...
//     `;
// };

// // 1. Define the desired JSON output structure using Zod.
// const planSchema = z.object({
//     searchApiQuery: z.string().describe("A highly optimized, single-line search query string to be used with a Google Search API."),
//     extractionPrompt: z.string().describe("A detailed prompt for a different AI model that will run later to extract structured data from the raw search results according to the intension of user from the data."),
// });

// // Define a TypeScript type from the Zod schema for type safety
// type Plan = z.infer<typeof planSchema>;

// const planParser = StructuredOutputParser.fromZodSchema(planSchema);

// // 2. This function calls the Groq LLM using the LangChain framework.
// const getPlanFromLLM = async (userPrompt: string): Promise<Plan> => {
//     const apiKey = process.env.GROQ_API_KEY;
//     if (!apiKey) {
//         throw new Error("GROQ_API_KEY is not set in environment variables.");
//     }

//     // Instantiate the Groq model via LangChain
//     const model = new ChatGroq({
//         apiKey: apiKey,
//         model: "meta-llama/llama-4-maverick-17b-128e-instruct",
//         temperature: 0.2,
//         maxRetries: 0 // This is the necessary change to disable automatic retries.
//     });

//     // Create a prompt template that includes LangChain's formatting instructions.
//     const promptTemplate = new PromptTemplate({
//         template: `You are an AI planner for a web scraping system. Your task is to analyze the user's request and generate a JSON object containing a plan to scrape the requested data.

//         Follow these instructions precisely:
//         1. Analyze the user's prompt to understand their intent.
//         2. Generate a JSON object that strictly adheres to the provided schema.
//         3. Do NOT output any conversational text, explanations, or markdown formatting before or after the JSON object. Your entire response must be only the valid JSON.

//         {format_instructions}

//         User's request:
//         ${userPrompt}`,
//         inputVariables: ["prompt"],
//         partialVariables: { format_instructions: planParser.getFormatInstructions() },
//     });

//     // Create the chain by piping the components together.
//     const chain = promptTemplate.pipe(model).pipe(planParser);

//     console.log("Invoking LangChain chain...");
//     const plan = await chain.invoke({ prompt: userPrompt });

//     return plan;
// };

// // 3. The main API handler, now using LangChain
// export async function POST(req: Request) {
//     const { prompt } = await req.json();
//     if (!prompt) {
//         return NextResponse.json({ message: 'Prompt is required' }, { status: 400 });
//     }

//     try {
//         console.log("Stage 1: Generating plan from user prompt using LangChain...");
//         const plan: Plan = await getPlanFromLLM(prompt);

//         const { searchApiQuery, extractionPrompt } = plan;

//         console.log("Stage 1: Returning plan to client...","search query", searchApiQuery," extraction prompt ", extractionPrompt);

//         return NextResponse.json({
//             searchApiQuery,
//             extractionPrompt,
//         }, { status: 200 });

//     } catch (error: unknown) {
//         // LangChain may wrap the original API error. This checks for rate limit errors.
//         const errorMessage = error instanceof Error ? error.message : 'An unknown server error occurred';
//         if (errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")) {
//             console.error("Rate limit error detected via LangChain:", error);
//             return NextResponse.json({ message: 'You exceeded your current quota. Please wait a moment and try again.' }, { status: 429 });
//         }

//         console.error("Error in LangChain route handler:", error);
//         return NextResponse.json({ message: errorMessage }, { status: 500 });
//     }
// }

import { NextResponse } from 'next/server';
import { ChatGroq } from "@langchain/groq";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { PromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import axios from 'axios';

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
        template: `You are an expert AI planner for a web scraping system. Your task is to take a user's request and generate a structured JSON plan to scrape the required data.

        Follow this process:
        1.  **Analyze Intent:** Deeply analyze the user's request to identify the core entities and the specific data fields they want.
        2.  **Define Schema:** Based on the identified fields, define a clear data schema. This schema will guide the final data extraction.
        3.  **Construct Plan:** Create the final JSON plan containing a highly specific \`searchApiQuery\` and a detailed \`extractionPrompt\` that includes the schema. When creating the \`searchApiQuery\`, prioritize well-known directory or review sites (like linkedin.com for jobs, zomato.com or tripadvisor.com for restaurants) and avoid overly restrictive queries.

        Your entire response must be ONLY the valid JSON object, with no conversational text or markdown.

        {format_instructions}

        ---
        **EXAMPLE 1**
        **User's request:** "Find SDE-1 remote job openings and include the company name and an apply link"
        **Your JSON Output:**
        {{
          "searchApiQuery": "site:linkedin.com/jobs OR site:greenhouse.io OR site:lever.co \\"SDE 1\\" OR \\"Software Development Engineer 1\\" remote",
          "extractionPrompt": "From the provided raw text of job listings, extract an array of jobs. For each job, extract the following fields: 'jobTitle', 'companyName', and a direct 'applicationUrl'. If a field is missing, use 'N/A'."
        }}
        ---
        **EXAMPLE 2**
        **User's request:** "List all the vegan restaurants in Jaipur, India with their address and average rating"
        **Your JSON Output:**
        {{
          "searchApiQuery": "(\\"best vegan restaurants in Jaipur\\") site:zomato.com OR site:tripadvisor.in OR site:happycow.net",
          "extractionPrompt": "From the provided raw text of restaurant listings, extract an array of restaurants. For each restaurant, extract the following fields: 'restaurantName', 'fullAddress', and 'averageRating' (as a number). If a field is missing, use 'N/A'."
        }}
        ---

        **User's request:**
        ${userPrompt}`,
        inputVariables: ["prompt"],
        partialVariables: { format_instructions: planParser.getFormatInstructions() },
    });

    const chain = promptTemplate.pipe(model).pipe(planParser);

    console.log("Invoking LangChain chain to generate plan...");
    return await chain.invoke({ prompt: userPrompt });
};


// --- STAGE 2: GOOGLE SEARCH EXECUTION ---

// Define a type for the items returned by the Google Search API for better type safety
interface GoogleSearchItem {
    link: string;
    snippet: string;
}

// ** NECESSARY CHANGE 2: Update the function to return a list of URLs (string[]) **
const callGoogleSearchApi = async (searchQuery: string, numResults = 30): Promise<string[]> => {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;

    if (!apiKey || !cseId) {
        throw new Error("Google API Key or CSE ID is not set.");
    }

    let allUrls: string[] = [];
    const numRequests = Math.ceil(numResults / 10); // Calculate how many pages to fetch

    for (let i = 0; i < numRequests; i++) {
        const startIndex = i * 10 + 1;
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(searchQuery)}&start=${startIndex}`;

        console.log(`Executing Google Search (Page ${i + 1}) with query: ${searchQuery}`);

        try {
            const response = await axios.get(url);
            const items: GoogleSearchItem[] = response.data.items || [];
            const urls = items.map((item) => item.link);
            allUrls = allUrls.concat(urls);

            // If Google returns less than 10 results, it means we've reached the end.
            if (items.length < 10) {
                break; 
            }
        } catch (error) {
            console.error(`Error fetching page ${i + 1} of Google Search results:`, error);
            // Stop trying if one of the pages fails
            break;
        }
    }

    return allUrls.slice(0, numResults); // Return the final list, capped at the desired number
};


// --- MAIN API HANDLER ---

export async function POST(req: Request) {
    const { prompt } = await req.json();
    if (!prompt) {
        return NextResponse.json({ message: 'Prompt is required' }, { status: 400 });
    }

    try {
        // STAGE 1: Generate the plan
        console.log("--- Starting Stage 1: Planning ---");
        const plan = await getPlanFromLLM(prompt);
        // Only destructure the variable we need for this stage
        const { searchApiQuery, extractionPrompt } = plan;
        console.log("Stage 1 complete. Generated plan:", plan);
        // STAGE 2: Execute the search
        console.log("--- Starting Stage 2: Searching ---");

        const urls = await callGoogleSearchApi(searchApiQuery);
        console.log("Stage 2 complete. Found potential URLs: ", urls);

        console.log("--- Workflow Complete. Returning results. ---");
        return NextResponse.json({
            plan,
            urls 
        }, { status: 200 });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown server error occurred';
        if (errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")) {
            console.error("Rate limit error detected:", error);
            return NextResponse.json({ message: 'You exceeded your current quota. Please wait a moment and try again.' }, { status: 429 });
        }

        console.error("Error in API handler:", error);
        return NextResponse.json({ message: errorMessage }, { status: 500 });
    }
}



