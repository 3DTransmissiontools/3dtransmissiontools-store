import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "@neondatabase/serverless";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  scriptDirectory,
  "..",
  "db",
  "001_security_inventory.sql"
);
const migration = await fs.readFile(migrationPath, "utf8");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not configured.");
}

const pool = new Pool({ connectionString: databaseUrl });
await pool.query(migration);
await pool.end();
console.log("Applied inventory and security migration.");
