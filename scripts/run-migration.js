import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "@neondatabase/serverless";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.join(scriptDirectory, "..", "db");
const migrationFiles = (await fs.readdir(migrationDirectory))
  .filter(file => /^\d+_.+\.sql$/.test(file))
  .sort();
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not configured.");
}

const pool = new Pool({ connectionString: databaseUrl });

for (const file of migrationFiles) {
  const migration = await fs.readFile(
    path.join(migrationDirectory, file),
    "utf8"
  );

  await pool.query(migration);
  console.log(`Applied ${file}.`);
}

await pool.end();
console.log(`Applied ${migrationFiles.length} database migration(s).`);

