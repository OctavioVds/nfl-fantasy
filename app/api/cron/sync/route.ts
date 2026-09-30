import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { synchronize } from "@/lib/orchestrator";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const supplied = Buffer.from(actual);
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await synchronize()); }
  catch { return NextResponse.json({ error: "Sync failed" }, { status: 500 }); }
}
