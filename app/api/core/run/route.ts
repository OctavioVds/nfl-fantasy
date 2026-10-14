import { coreInputSchema } from "@/lib/core/schema";
import { runCore } from "@/lib/core/run";
import { bearerAuthorized, privateHeaders, sameOrigin } from "@/lib/core/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  if (request.headers.get("authorization")?.startsWith("Bearer ") && !bearerAuthorized(request, "ingest")) return Response.json({ error: "Unauthorized" }, { status: 401, headers: privateHeaders });
  if (!sameOrigin(request) && !bearerAuthorized(request, "ingest")) return Response.json({ error: "Origin or ingest authorization required" }, { status: 403, headers: privateHeaders });
  const raw = await request.text();
  if (raw.length > 2_000_000) return Response.json({ error: "Import exceeds 2 MB; use offline ingestion" }, { status: 413, headers: privateHeaders });
  let input;
  if (raw.trim()) {
    const parsed = coreInputSchema.safeParse((() => { try { return JSON.parse(raw).input; } catch { return null; } })());
    if (!parsed.success) return Response.json({ error: "Invalid core input", issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, { status: 400, headers: privateHeaders });
    input = parsed.data;
  }
  try { return Response.json(await runCore(input), { headers: privateHeaders }); }
  catch (error) { return Response.json({ error: error instanceof Error && error.message === "CORE_INPUT_MISSING" ? "No hay una consulta de liga importada. Actualiza la liga en el chat o importa un snapshot verificado primero." : "El núcleo no está disponible. Revisa migraciones y estado de las fuentes." }, { status: error instanceof Error && error.message === "CORE_INPUT_MISSING" ? 409 : 503, headers: privateHeaders }); }
}
