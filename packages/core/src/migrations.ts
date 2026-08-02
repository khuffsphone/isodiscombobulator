import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * Workspace migrations.
 *
 * Append only — never edit a shipped migration. An operator's workspace is the
 * authoritative record of an investigation and may be months old.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE rom (
          sha256        TEXT PRIMARY KEY,
          sha1          TEXT NOT NULL,
          platform      TEXT NOT NULL,
          byte_length   INTEGER NOT NULL,
          source_format TEXT NOT NULL,
          source_path   TEXT NOT NULL,
          imported_at   TEXT NOT NULL,
          header_json   TEXT NOT NULL
        );

        CREATE TABLE session (
          id            TEXT PRIMARY KEY,
          rom_sha256    TEXT NOT NULL REFERENCES rom(sha256),
          adapter       TEXT NOT NULL,
          emulator_json TEXT NOT NULL,
          started_at    TEXT NOT NULL,
          ended_at      TEXT,
          scenario      TEXT
        );

        CREATE TABLE capture (
          capture_id    TEXT PRIMARY KEY,
          session_id    TEXT NOT NULL,
          rom_sha256    TEXT NOT NULL REFERENCES rom(sha256),
          frame         INTEGER NOT NULL,
          scenario      TEXT,
          manifest_json TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX capture_by_session ON capture(session_id, frame);

        CREATE TABLE command_log (
          session_id   TEXT NOT NULL,
          sequence     INTEGER NOT NULL,
          command_json TEXT NOT NULL,
          frame_before INTEGER NOT NULL,
          frame_after  INTEGER NOT NULL,
          at           TEXT NOT NULL,
          PRIMARY KEY (session_id, sequence)
        );

        -- Append-only, hash-chained. Rows are never updated or deleted;
        -- a correction is a new record that supersedes an older one.
        CREATE TABLE evidence (
          seq          INTEGER PRIMARY KEY AUTOINCREMENT,
          id           TEXT NOT NULL UNIQUE,
          rom_sha256   TEXT NOT NULL,
          kind         TEXT NOT NULL,
          subject      TEXT NOT NULL,
          origin       TEXT NOT NULL,
          verification TEXT NOT NULL,
          confidence   REAL NOT NULL,
          capture_id   TEXT,
          frame        INTEGER,
          record_json  TEXT NOT NULL,
          prev_hash    TEXT NOT NULL,
          record_hash  TEXT NOT NULL,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX evidence_by_rom ON evidence(rom_sha256, kind);
        CREATE INDEX evidence_by_capture ON evidence(capture_id);

        CREATE TABLE note (
          id         TEXT PRIMARY KEY,
          rom_sha256 TEXT NOT NULL,
          capture_id TEXT,
          frame      INTEGER,
          body       TEXT NOT NULL,
          author     TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function applyMigrations(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migration').all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );

  const insert = db.prepare(
    'INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      insert.run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${String(error)}`, {
        cause: error,
      });
    }
  }

  return LATEST_SCHEMA_VERSION;
}
