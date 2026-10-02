import { NextResponse } from "next/server";
import { synchronize } from "@/lib/orchestrator";
import { fetchFlaimLeagueSnapshot } from "@/lib/flaim/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  if (process.env.FLAIM_MCP_SYNC_V1 !== "1") return NextResponse.json({ error: "Flaim sync is disabled.", needsConnection: false }, { status: 404 });
  try {
    const league = await fetchFlaimLeagueSnapshot();
    const snapshot = await synchronize(league);
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo consultar Flaim.";
    const needsConnection = message.startsWith("Conecta Flaim");
    return NextResponse.json({ error: message, needsConnection }, { status: needsConnection ? 409 : 502, headers: { "Cache-Control": "no-store" } });
  }
}
