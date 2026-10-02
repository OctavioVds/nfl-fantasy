import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type FlaimTokenSet = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expiresAt?: number;
  resource: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
};

let memoryConnection: FlaimTokenSet | null = null;

function encryptionKey() {
  const master = process.env.EXTERNAL_SYNC_SECRET || process.env.CRON_SECRET;
  if (!master) throw new Error("Flaim secure storage is not configured.");
  const key = hkdfSync("sha256", Buffer.from(master), Buffer.from("nfl-fantasy-command-center"), Buffer.from("flaim-oauth-token-storage-v1"), 32);
  return Buffer.from(key);
}

export function encryptJson(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("flaim-oauth-v1"));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptJson<T>(value: string): T {
  const [ivValue, tagValue, bodyValue] = value.split(".");
  if (!ivValue || !tagValue || !bodyValue) throw new Error("Stored Flaim authorization is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAAD(Buffer.from("flaim-oauth-v1"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const clear = Buffer.concat([decipher.update(Buffer.from(bodyValue, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(clear) as T;
}

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === "development") return null;
    throw new Error("Flaim connection requires the configured Neon database.");
  }
  return neon(url);
}

async function ensureTable(sql: NeonQueryFunction<false, false>) {
  await sql`create table if not exists flaim_connections (
    id text primary key,
    encrypted_payload text not null,
    connected_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
}

export async function saveFlaimConnection(connection: FlaimTokenSet) {
  const sql = getSql();
  const encrypted = encryptJson(connection);
  if (!sql) {
    memoryConnection = connection;
    return;
  }
  await ensureTable(sql);
  await sql`insert into flaim_connections (id, encrypted_payload)
    values ('default', ${encrypted})
    on conflict (id) do update set encrypted_payload = excluded.encrypted_payload, updated_at = now()`;
}

export async function loadFlaimConnection() {
  const sql = getSql();
  if (!sql) return memoryConnection;
  await ensureTable(sql);
  const rows = await sql`select encrypted_payload from flaim_connections where id = 'default' limit 1`;
  const encrypted = rows[0]?.encrypted_payload;
  return typeof encrypted === "string" ? decryptJson<FlaimTokenSet>(encrypted) : null;
}

export async function removeFlaimConnection() {
  const sql = getSql();
  if (!sql) {
    memoryConnection = null;
    return;
  }
  await ensureTable(sql);
  await sql`delete from flaim_connections where id = 'default'`;
}
