import { getCoreRun } from "@/lib/core/store";
import { privateHeaders } from "@/lib/core/http";
import { publishedRun } from "@/lib/core/service";
export const runtime = "nodejs";
export async function GET() {
  try { return Response.json({run:publishedRun(await getCoreRun())}, { headers: privateHeaders }); }
  catch { return Response.json({ run: null, reason: "Core schema or database unavailable" }, { status: 503, headers: privateHeaders }); }
}
