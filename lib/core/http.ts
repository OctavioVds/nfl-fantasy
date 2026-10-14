import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "../env";

export function bearerAuthorized(request: Request, kind: "cron" | "ingest") {
  const env = serverEnv();
  const expected = kind === "cron" ? env.CRON_SECRET : env.EXTERNAL_SYNC_SECRET;
  const value = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!expected || !value) return false;
  const a = Buffer.from(value); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  const internal = new URL(request.url);
  const host = request.headers.get("host") ?? request.headers.get("x-forwarded-host") ?? internal.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? internal.protocol.replace(":", "");
  return ["http", "https"].includes(protocol) && origin === `${protocol}://${host}`;
}
export const privateHeaders = { "Cache-Control": "private, no-store" };
