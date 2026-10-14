import { serverEnv } from "./env";

export async function captureServerEvent(event: string, properties: Record<string, unknown> = {}) {
  const env = serverEnv();
  if (!env.POSTHOG_KEY) return;
  const host = env.POSTHOG_HOST;
  await fetch(`${host}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: env.POSTHOG_KEY, event, properties: { distinct_id: "fantasy-command-center", ...properties } }),
  }).catch(() => undefined);
}
