import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { captureServerEvent } from "@/lib/analytics";
import { synchronize } from "@/lib/orchestrator";
import { externalSyncSchema } from "@/lib/schemas";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.EXTERNAL_SYNC_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = externalSyncSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  try { return NextResponse.json(await synchronize(parsed.data)); }
  catch (error) { await captureServerEvent("sync_failed", { message: error instanceof Error ? error.message : "unknown" }); return NextResponse.json({ error: "Sync failed" }, { status: 500 }); }
}
