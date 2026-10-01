import { NextResponse } from "next/server";
import { loadFlaimConnection } from "@/lib/flaim/storage";

export const runtime = "nodejs";

export async function GET() {
  if (process.env.FLAIM_MCP_SYNC_V1 !== "1") {
    return NextResponse.json({ enabled: false, connected: false }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const connection = await loadFlaimConnection();
    return NextResponse.json({ enabled: true, connected: Boolean(connection) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ connected: false, storageReady: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
