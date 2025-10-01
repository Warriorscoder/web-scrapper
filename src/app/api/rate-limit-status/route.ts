import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis'; 

const DAILY_LIMIT = 90;

export async function GET() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const rateLimitKey: string = `google_api_limit:${today}`;

        const currentUsageRaw = await redis.get(rateLimitKey as string);
        const currentUsage = currentUsageRaw ? parseInt(currentUsageRaw.toString(), 10) : 0;

        console.log("Rate limit usage for today:", currentUsage);

        const remaining = Math.max(0, DAILY_LIMIT - currentUsage);

        return NextResponse.json(
            { requestsRemaining: remaining, used: currentUsage, limit: DAILY_LIMIT },
            { status: 200 }
        );

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown server error occurred';
        console.error("Error fetching rate limit status:", errorMessage);

        return NextResponse.json(
            { requestsRemaining: DAILY_LIMIT, error: "Could not retrieve status." },
            { status: 500 }
        );
    }
}
