import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis'; 

// Ensure this limit is consistent with your main API route
const DAILY_LIMIT = 90;

export async function GET(req: Request) {
    try {
        const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1';
        
        const rateLimitKey = `google_api_limit:${ip}`;

        const currentUsage = await redis.get<number>(rateLimitKey) || 0;
        console.log("currentUsage ", currentUsage)
        
        const remaining = Math.max(0, DAILY_LIMIT - currentUsage);

        return NextResponse.json({ requestsRemaining: remaining }, { status: 200 });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown server error occurred';
        console.error("Error fetching rate limit status:", errorMessage);
        
        // Return a fallback value if Redis fails
        return NextResponse.json({ requestsRemaining: DAILY_LIMIT, error: "Could not retrieve status." }, { status: 500 });
    }
}

