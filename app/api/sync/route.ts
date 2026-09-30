import { NextResponse } from "next/server";
import { synchronize } from "@/lib/orchestrator";

export const runtime = "nodejs";

export async function POST() {
  try { return NextResponse.json(await synchronize(), { status: 200 }); }
  catch { return NextResponse.json({ error: "Sync failed" }, { status: 500 }); }
}
