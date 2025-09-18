'use client'

import React, { useEffect, useRef, useState } from "react";
import { BackgroundPaths } from "./ui/background-paths";
import axios, { isAxiosError } from "axios";

interface ScrapeResult {
    plan: {
        searchApiQuery: string;
        extractionPrompt: string;
    };
    structuredData: Record<string, unknown>[]; 
}

function Hero() {
    const [prompt, setPrompt] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [rateLimitSeconds, setRateLimitSeconds] = useState(0);
    const [requestsLeft, setRequestsLeft] = useState(30);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [scrapeResult, setScrapeResult] = useState<ScrapeResult | null>(null);

    useEffect(() => {
        if (rateLimitSeconds > 0) {
            const timer = setInterval(() => setRateLimitSeconds(s => s - 1), 1000);
            return () => clearInterval(timer);
        }
    }, [rateLimitSeconds]);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    }, [prompt]);

    const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setPrompt(e.target.value);
    };

    // const handleSubmit = async () => {
    //     if (!prompt.trim() || rateLimitSeconds > 0 || requestsLeft === 0 || isLoading) return;

    //     setIsLoading(true); // Set loading true
    //     try {
    //         const response = await axios.post('/api/get-prompt', { prompt });
    //         console.log("Response from /api/get-prompt:", response.data);

    //         setRequestsLeft(prev => prev - 1);
    //         setPrompt("");
    //         setShowSuccessMessage(true);
    //         setTimeout(() => setShowSuccessMessage(false), 3000);

    //     } catch (error) {
    //         console.error("Error submitting prompt:", error);
    //         if (isAxiosError(error) && error.response?.status === 429) {
    //             setRateLimitSeconds(60);
    //         }
    //     } finally {
    //         setIsLoading(false); // Set loading false
    //     }
    // };
     const handleSubmit = async () => {
        if (!prompt.trim() || isLoading || rateLimitSeconds > 0 || requestsLeft === 0) return;
        setIsLoading(true);
        setError(null);
        setScrapeResult(null);

        try {
            const response = await axios.post('/api/get-prompt', { prompt });
            setScrapeResult(response.data);
            setRequestsLeft(prev => prev - 1);
        } catch (err) {
            if (isAxiosError(err)) {
                setError(err.response?.data?.message || "An error occurred.");
                if (err.response?.status === 429) setRateLimitSeconds(60);
            } else {
                setError("An unexpected error occurred.");
            }
        } finally {
            setIsLoading(false);
        }
    };

    const handleDownload = async () => {
        if (!scrapeResult || !scrapeResult.structuredData || !Array.isArray(scrapeResult.structuredData) || scrapeResult.structuredData.length === 0) {
            setError("No data available to download.");
            return;
        }
        setError(null);

        try {
            const response = await axios.post('/api/generate-excel', scrapeResult.structuredData, {
                responseType: 'blob', // This is crucial to receive the file data correctly
            });
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', 'scraped_data.xlsx');
            document.body.appendChild(link);
            link.click();
            link.parentNode?.removeChild(link);
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Error downloading excel file:", error);
            setError("Could not download the Excel file.");
        }
    };

    const handleReset = () => {
        setPrompt("");
        setScrapeResult(null);
        setError(null);
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const isInputDisabled = isLoading || rateLimitSeconds > 0;
    const tableHeaders = scrapeResult && scrapeResult.structuredData && Array.isArray(scrapeResult.structuredData) && scrapeResult.structuredData.length > 0 
        ? Object.keys(scrapeResult.structuredData[0]) 
        : [];
    
    // Updated disabled logic for the textarea
    const isTextareaDisabled = isLoading || rateLimitSeconds > 0;
    const isButtonDisabled = !prompt.trim() || isTextareaDisabled || requestsLeft === 0;

    return (
        <div className="relative w-full min-h-screen flex flex-col items-center justify-center font-sans overflow-hidden p-4">
            <BackgroundPaths />

            <div className="relative z-10 flex flex-col items-center w-full max-w-4xl text-center my-auto">
                <h1 className="text-gray-200 text-5xl sm:text-6xl font-bold mb-8 animate-fade-in-up">
                    Welcome to Scrapper
                </h1>

                {scrapeResult ? (
                    <div className="w-full bg-gray-900/70 border border-gray-700 rounded-2xl p-6 text-left animate-fade-in-up">
                        <h2 className="text-xl font-bold text-cyan-400 mb-4">Scraping Complete</h2>
                        <div className="max-h-96 overflow-y-auto">
                            <table className="w-full text-sm text-left text-gray-300">
                                <thead className="text-xs text-gray-400 uppercase bg-gray-800 sticky top-0">
                                    <tr>{tableHeaders.map(header => <th key={header} className="py-3 px-6">{header}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {scrapeResult.structuredData && Array.isArray(scrapeResult.structuredData) && scrapeResult.structuredData.length > 0 ? scrapeResult.structuredData.map((row, index) => (
                                        <tr key={index} className="bg-gray-900/50 border-b border-gray-700">
                                            {tableHeaders.map(header => <td key={header} className="py-4 px-6 break-words">{String(row[header])}</td>)}
                                        </tr>
                                    )) : (
                                        <tr><td colSpan={tableHeaders.length || 1} className="text-center py-4">No structured data was extracted.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <div className="mt-6 border-t border-gray-700 pt-4 flex justify-end gap-4">
                            <button onClick={handleReset} className="px-4 py-2 text-sm text-gray-300 bg-gray-700 rounded-md hover:bg-gray-600 transition-colors">New Search</button>
                            <button onClick={handleDownload} className="px-4 py-2 text-sm font-semibold text-gray-900 bg-cyan-500 rounded-md hover:bg-cyan-400 transition-colors">Download Excel</button>
                        </div>
                    </div>
                ) : (
                    <div className="w-full">
                        <div className="h-8 mb-2">
                            {/* Placeholder for status messages */}
                        </div>
                        <div className="w-full bg-gray-900/70 backdrop-blur-sm border border-gray-700 rounded-2xl p-4 flex items-end shadow-lg transition-all duration-300 focus-within:ring-2 focus-within:ring-cyan-500 animate-fade-in-up">
                            <textarea
                                ref={textareaRef}
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                onKeyDown={handleKeyDown}
                                rows={1}
                                className="w-full bg-transparent text-gray-200 text-lg placeholder-gray-500 resize-none focus:outline-none"
                                placeholder="Find me remote Senior TypeScript developer jobs..."
                                disabled={isInputDisabled}
                            />
                            <button onClick={handleSubmit} disabled={!prompt.trim() || isInputDisabled || requestsLeft === 0} className="ml-4 w-10 h-10 flex-shrink-0 rounded-full bg-cyan-500 text-gray-900 flex items-center justify-center transition-all duration-200 hover:bg-cyan-400 disabled:bg-gray-600 disabled:cursor-not-allowed font-mono text-lg">
                                {isLoading ? <LoadingSpinner/> : rateLimitSeconds > 0 ? <span>{rateLimitSeconds}</span> : <SendIcon className="w-6 h-6" />}
                            </button>
                        </div>
                    </div>
                )}
                {error && <p className="mt-4 text-yellow-400">{error}</p>}
            </div>
            
            <div className="absolute bottom-6 text-xs text-gray-500 mt-auto">
                Requests remaining this session: {requestsLeft}
            </div>
        </div>
    );
}

export default Hero;


const SendIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M7 11L12 6L17 11M12 18V7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const LoadingSpinner = () => (<svg className="animate-spin h-6 w-6 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>);