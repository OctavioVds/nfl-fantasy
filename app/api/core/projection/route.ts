import { getProjection } from "@/lib/core/service";
import { privateHeaders } from "@/lib/core/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const week = Number(q.get("week")); const player = q.get("player");
  if (!player || !Number.isInteger(week) || week < 1 || week > 18) return Response.json({ error: "player ID and week 1–18 required" }, { status: 400, headers: privateHeaders });
  try { const result = await getProjection(player, week, q.get("scenario") ?? "base", q.get("scope") ?? undefined); return Response.json(result, { status: result.projection ? 200 : 404, headers: privateHeaders }); }
  catch { return Response.json({ projection: null, reason: "Core storage unavailable" }, { status: 503, headers: privateHeaders }); }
}
