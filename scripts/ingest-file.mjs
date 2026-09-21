import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const file = process.argv[2];
if (!file) throw new Error("Usage: npm run db:ingest -- <payload.json>");

const payload = JSON.parse(await readFile(file, "utf8"));
if (!payload?.league?.season || !payload?.league?.week || !payload?.sourceTimestamp || !payload?.source) {
  throw new Error("Invalid external sync payload");
}

const sql = neon(process.env.DATABASE_URL);
await sql`insert into external_ingest_events (source, season, week, payload, source_timestamp)
  values (${payload.source}, ${payload.league.season}, ${payload.league.week}, ${JSON.stringify(payload)}::jsonb, ${payload.sourceTimestamp})`;
console.log(`Stored ${payload.source} snapshot for ${payload.league.season} week ${payload.league.week}.`);
