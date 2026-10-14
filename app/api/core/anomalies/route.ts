import { getCoreRun } from "@/lib/core/store";
import { privateHeaders } from "@/lib/core/http";
import { coreRunFresh, publishedRun } from "@/lib/core/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const run = publishedRun(await getCoreRun(new URL(request.url).searchParams.get("scope") ?? undefined)); return Response.json({ run_id: run?.run_id ?? null, anomalies: run?.anomalies ?? [], source_as_of: run?.source_as_of ?? null, stale: !coreRunFresh(run), reason: run ? run.gate.reason : "No core run available" }, { headers: privateHeaders }); }
  catch { return Response.json({ anomalies: [], reason: "Storage unavailable" }, { status: 503, headers: privateHeaders }); }
}
