'use client'

import React, { useEffect, useRef, useState } from "react";
import { BackgroundPaths } from "./ui/background-paths";
import axios, { isAxiosError } from "axios";

function Hero() {
    const [prompt, setPrompt] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [rateLimitSeconds, setRateLimitSeconds] = useState(0);
    const [requestsLeft, setRequestsLeft] = useState(30);
    const [showSuccessMessage, setShowSuccessMessage] = useState(false);
    const [isLoading, setIsLoading] = useState(false); // Added loading state

    useEffect(() => {
        if (rateLimitSeconds > 0) {
            const timer = setInterval(() => {
                setRateLimitSeconds(prevSeconds => prevSeconds - 1);
            }, 1000);
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

    const handleSubmit = async () => {
        if (!prompt.trim() || rateLimitSeconds > 0 || requestsLeft === 0 || isLoading) return;

        setIsLoading(true); // Set loading true
        try {
            const response = await axios.post('/api/get-prompt', { prompt });
            console.log("Response from /api/get-prompt:", response.data);

            setRequestsLeft(prev => prev - 1);
            setPrompt("");
            setShowSuccessMessage(true);
            setTimeout(() => setShowSuccessMessage(false), 3000);

        } catch (error) {
            console.error("Error submitting prompt:", error);
            if (isAxiosError(error) && error.response?.status === 429) {
                setRateLimitSeconds(60);
            }
        } finally {
            setIsLoading(false); // Set loading false
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };
    
    // Updated disabled logic for the textarea
    const isTextareaDisabled = isLoading || rateLimitSeconds > 0;
    const isButtonDisabled = !prompt.trim() || isTextareaDisabled || requestsLeft === 0;

    return (
        <div className="relative w-full h-screen flex items-center justify-center font-sans overflow-hidden">
            <BackgroundPaths />

            <div className="absolute z-10 flex flex-col items-center w-full max-w-4xl px-4 text-center">
                <h1
                    className="text-gray-200 text-5xl sm:text-6xl md:text-7xl font-bold mb-8 animate-fade-in-up"
                    style={{ animationDelay: '0.1s' }}
                >
                    Welcome to Scrapper
                </h1>

                <div className="h-8 mb-2">
                    {showSuccessMessage && (
                        <div className="text-cyan-400 animate-fade-in-up">
                            Request Sent!
                        </div>
                    )}
                </div>

                <div
                    className="w-full bg-gray-900/70 backdrop-blur-sm border border-gray-700 rounded-2xl p-4 flex items-end shadow-lg transition-all duration-300 focus-within:ring-2 focus-within:ring-cyan-500 animate-fade-in-up"
                    style={{ animationDelay: '0.3s' }}
                >
                    <textarea
                        ref={textareaRef}
                        value={prompt}
                        onChange={handlePromptChange}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        className="w-full bg-transparent text-gray-200 text-lg placeholder-gray-500 resize-none focus:outline-none overflow-y-hidden"
                        placeholder="Tell me what you need to find..."
                        disabled={isTextareaDisabled} // Corrected disabled logic
                    />
                    <button
                        onClick={handleSubmit}
                        disabled={isButtonDisabled}
                        className="ml-4 w-10 h-10 flex-shrink-0 rounded-full bg-cyan-500 text-gray-900 flex items-center justify-center transition-all duration-200 hover:bg-cyan-400 disabled:bg-gray-600 disabled:cursor-not-allowed font-mono text-lg"
                        aria-label="Submit prompt"
                    >
                        {rateLimitSeconds > 0 ? (
                            <span>{rateLimitSeconds}</span>
                        ) : (
                            <SendIcon className="w-6 h-6" />
                        )}
                    </button>
                </div>

                {/* <div className="absolute bottom-6 text-xs text-gray-500 animate-fade-in-up" style={{ animationDelay: '0.7s' }}>
                    Requests remaining this session: {requestsLeft}
                </div> */}

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