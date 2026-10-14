import { getCoreRun } from "@/lib/core/store";
import { privateHeaders } from "@/lib/core/http";
import { coreRunFresh, publishedRun } from "@/lib/core/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams; const team = q.get("team");
  if (!team) return Response.json({ error: "team ID required" }, { status: 400, headers: privateHeaders });
  try { const run = publishedRun(await getCoreRun(q.get("scope") ?? undefined)); const availability = run?.availability.find((row) => row.team_id === team) ?? null; return Response.json({ availability, source_as_of: run?.source_as_of ?? null, stale: !coreRunFresh(run), reason: availability ? null : "Team scenarios unavailable or league evidence stale" }, { headers: privateHeaders }); }
  catch { return Response.json({ availability: null, reason: "Storage unavailable" }, { status: 503, headers: privateHeaders }); }
}
