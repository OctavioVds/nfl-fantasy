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
  const flaimError = typeof query.flaim_error === "string" ? query.flaim_error : "";
  const redirectUri = typeof query.flaim_redirect_uri === "string" ? query.flaim_redirect_uri.slice(0, 300) : "";
  const initialError = flaimState === "error"
    ? "No se completó la autorización de Flaim. Pulsa Conectar Flaim e inténtalo otra vez."
    : flaimError === "redirect_uri_rejected"
      ? `Flaim rechazó el callback OAuth (${flaimError}). Solicita que autoricen esta URL: ${redirectUri || "callback de la app"}.`
      : flaimError === "client_registration_unavailable"
        ? "Flaim no ofrece registro automático para esta app. Se necesita un client ID OAuth autorizado por Flaim."
        : flaimError === "client_registration_failed"
          ? "Flaim rechazó el registro del cliente OAuth. Revisa el identificador de error en el mensaje y solicita autorizar la app."
          : flaimError === "authorization_metadata_unavailable"
            ? "Flaim no publicó los metadatos OAuth necesarios para iniciar la conexión."
            : flaimError === "pkce_unavailable"
              ? "Flaim no ofrece PKCE S256; la conexión se detuvo por seguridad."
              : flaimError === "read_scope_unavailable"
                ? "Flaim no ofrece el permiso de solo lectura que esta app requiere. No se solicitó acceso de escritura."
                : flaimError === "oauth_setup_failed"
                  ? "No se pudo iniciar la conexión OAuth de Flaim. Revisa los logs de Vercel para el código de falla."
                  : query.flaim_sync === "error"
                    ? "Flaim quedó conectado, pero no se pudo importar el roster. Pulsa Sincronizar para reintentar."
                    : null;
  const autoSync = flaimState === "connected" || query.flaim_sync === "1";
  const initialNotice = flaimState === "connected" ? "Flaim autorizado; importando la liga y calculando decisiones…" : null;
  return <CommandCenter initialSnapshot={snapshot} flaimEnabled={flaimEnabled} initialFlaimConnected={flaimConnected} autoSync={autoSync} initialError={initialError} initialNotice={initialNotice} />;
}
