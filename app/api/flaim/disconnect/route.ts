import { NextResponse } from "next/server";
import { removeFlaimConnection } from "@/lib/flaim/storage";

export const runtime = "nodejs";

export async function POST() {
  try {
    await removeFlaimConnection();
    return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "No se pudo desconectar Flaim." }, { status: 500 });
  }
}
