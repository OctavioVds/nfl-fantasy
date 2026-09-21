import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = neon(process.env.DATABASE_URL);
const migration = await readFile(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8");
const statements = migration.split(";").map((statement) => statement.trim()).filter(Boolean);

for (const statement of statements) await sql.query(statement);
console.log(`Applied ${statements.length} migration statements.`);
