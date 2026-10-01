import { CommandCenter } from "@/components/command-center";
import { getLatestSnapshot } from "@/lib/db";
import { fallbackSnapshot } from "@/lib/fallback-data";
import { snapshotForDisplay } from "@/lib/snapshot-view";
import { loadFlaimConnection } from "@/lib/flaim/storage";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const snapshot = snapshotForDisplay((await getLatestSnapshot()) ?? fallbackSnapshot());
  const flaimEnabled = process.env.FLAIM_MCP_SYNC_V1 === "1";
  const query = await searchParams;
  let flaimConnected = false;
  if (flaimEnabled) {
    try { flaimConnected = Boolean(await loadFlaimConnection()); } catch { flaimConnected = false; }
  }
  const flaimState = typeof query.flaim === "string" ? query.flaim : "";
  const initialError = flaimState === "error"
    ? "No se completó la autorización de Flaim. Pulsa Conectar Flaim e inténtalo otra vez."
    : query.flaim_error === "setup"
      ? "Flaim no permitió registrar esta app automáticamente. Necesitamos que habiliten la conexión OAuth."
      : query.flaim_sync === "error"
        ? "Flaim quedó conectado, pero no se pudo importar el roster. Pulsa Sincronizar para reintentar."
        : null;
  const autoSync = flaimState === "connected" || query.flaim_sync === "1";
  const initialNotice = flaimState === "connected" ? "Flaim autorizado; importando la liga y calculando decisiones…" : null;
  return <CommandCenter initialSnapshot={snapshot} flaimEnabled={flaimEnabled} initialFlaimConnected={flaimConnected} autoSync={autoSync} initialError={initialError} initialNotice={initialNotice} />;
}
