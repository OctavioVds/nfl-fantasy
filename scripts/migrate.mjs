import { readFile, readdir } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = neon(process.env.DATABASE_URL);
const migrationsUrl = new URL("../db/migrations/", import.meta.url);
await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
const files = (await readdir(migrationsUrl)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
let appliedStatements = 0;

for (const file of files) {
  const prior = await sql`select version from schema_migrations where version = ${file} limit 1`;
  if (prior.length) continue;
  const migration = await readFile(new URL(file, migrationsUrl), "utf8");
  const statements = migration.split(";").map((statement) => statement.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  for (const statement of statements) await sql.query(statement);
  await sql`insert into schema_migrations (version) values (${file}) on conflict (version) do nothing`;
  appliedStatements += statements.length;
  console.log(`Applied ${file} (${statements.length} statements).`);
}
console.log(`Applied ${appliedStatements} new migration statements across ${files.length} migrations.`);
