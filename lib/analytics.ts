export async function captureServerEvent(event: string, properties: Record<string, unknown> = {}) {
  if (!process.env.POSTHOG_KEY) return;
  const host = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
  await fetch(`${host}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: process.env.POSTHOG_KEY, event, properties: { distinct_id: "fantasy-command-center", ...properties } }),
  }).catch(() => undefined);
}
