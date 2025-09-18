import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

export async function POST(req: Request) {
    try {
        const data = await req.json();

        // Ensure data is an array before processing
        if (!Array.isArray(data) || data.length === 0) {
            return NextResponse.json({ message: 'Invalid or empty data provided.' }, { status: 400 });
        }

        console.log("--- Starting Stage 4: Generating Excel File ---");

        // 1. Create a new workbook
        const workbook = XLSX.utils.book_new();
        
        // 2. Convert the JSON array to a worksheet
        const worksheet = XLSX.utils.json_to_sheet(data);
        
        // 3. Append the worksheet to the workbook
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Scraped Data');
        
        // 4. Write the workbook to a buffer (a raw data format)
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        console.log("--- Stage 4 Complete. Sending Excel file to client. ---");
        
        // 5. Return the buffer as a response with the correct headers to trigger a download
        return new NextResponse(buffer, {
            status: 200,
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': 'attachment; filename="scraped_data.xlsx"',
            },
        });

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown server error occurred';
        console.error("Error in Excel generation handler:", error);
        return NextResponse.json({ message: errorMessage }, { status: 500 });
    }
}
