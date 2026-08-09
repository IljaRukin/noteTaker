const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    const config = { connectionString: url };
    if (!url.includes("sslmode") && !/localhost|127\.0\.0\.1/.test(url)) {
      config.ssl = { rejectUnauthorized: false };
    }
    pool = new Pool(config);
  }
  return pool;
}

let schemaReady = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS notes (
            id         TEXT PRIMARY KEY,
            parent_id  TEXT REFERENCES notes(id) ON DELETE CASCADE,
            title      TEXT NOT NULL,
            content    TEXT NOT NULL DEFAULT '',
            position   INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            csrf       TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL
          )
        `);
        await client.query(`
          INSERT INTO notes (id, parent_id, title, content, position)
          VALUES ('root', NULL, 'Root', '# Welcome

This is the root note.', 0)
          ON CONFLICT (id) DO NOTHING
        `);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    })();
    await schemaReady;
  }
  return schemaReady;
}

module.exports = { getPool, ensureSchema };
