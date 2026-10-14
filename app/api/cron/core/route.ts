import { runCore } from "@/lib/core/run";
import { bearerAuthorized, privateHeaders } from "@/lib/core/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!bearerAuthorized(request, "cron")) return Response.json({ error: "Unauthorized" }, { status: 401, headers: privateHeaders });
  try { return Response.json(await runCore(), { headers: privateHeaders }); }
  catch (error) { return Response.json({ error: error instanceof Error && error.message === "CORE_INPUT_MISSING" ? "No verified league input available" : "Core run failed" }, { status: 503, headers: privateHeaders }); }
}
