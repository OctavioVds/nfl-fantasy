import { getBacktest } from "@/lib/core/service";
import { privateHeaders } from "@/lib/core/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return Response.json(await getBacktest(new URL(request.url).searchParams.get("scope") ?? undefined), { headers: privateHeaders }); }
  catch { return Response.json({ metrics: null, reason: "Backtest storage unavailable" }, { status: 503, headers: privateHeaders }); }
}
