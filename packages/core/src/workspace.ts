import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ROMLAB_VERSION,
  WORKSPACE_SCHEMA_ID,
  assertValid,
  validateCaptureManifest,
  validateRomRecord,
  validateWorkspaceManifest,
  type CaptureManifest,
  type CommandLogEntry,
  type RomRecord,
  type SessionRecord,
  type WorkspaceManifest,
} from '@romlab/schema';

import { EvidenceLedger } from './ledger.js';
import { LATEST_SCHEMA_VERSION, applyMigrations } from './migrations.js';
import { Logger, silentLogger } from './logging.js';

export const MANIFEST_FILENAME = 'romlab.json';
export const DATABASE_FILENAME = 'romlab.sqlite';

export class WorkspaceError extends Error {}

export interface OpenOptions {
  logger?: Logger;
}

/**
 * A ROMLab workspace: the authoritative record of one investigation.
 *
 * Conversations, screenshots and reports are derived views of this. The source
 * ROM is *referenced* by hash and path but never copied in, so a workspace can
 * be archived and shared without carrying cartridge data.
 */
export class Workspace {
  readonly ledger: EvidenceLedger;

  private constructor(
    readonly root: string,
    readonly manifest: WorkspaceManifest,
    private readonly db: DatabaseSync,
    private readonly logger: Logger,
  ) {
    this.ledger = new EvidenceLedger(db);
  }

  static create(root: string, options: { name: string; logger?: Logger }): Workspace {
    const manifestPath = path.join(root, MANIFEST_FILENAME);
    if (existsSync(manifestPath)) {
      throw new WorkspaceError(`A ROMLab workspace already exists at ${root}`);
    }

    for (const dir of ['', 'captures', 'exports', 'logs', 'private-repro']) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }

    const manifest: WorkspaceManifest = {
      schema: WORKSPACE_SCHEMA_ID,
      schemaVersion: LATEST_SCHEMA_VERSION,
      id: randomUUID(),
      name: options.name,
      createdAt: new Date().toISOString(),
      romlabVersion: ROMLAB_VERSION,
    };
    assertValid(validateWorkspaceManifest(manifest));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const db = new DatabaseSync(path.join(root, DATABASE_FILENAME));
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db);

    const logger = options.logger ?? silentLogger;
    logger.info('workspace created', { root, id: manifest.id });
    return new Workspace(root, manifest, db, logger);
  }

  static open(root: string, options: OpenOptions = {}): Workspace {
    const manifestPath = path.join(root, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      throw new WorkspaceError(`No ROMLab workspace at ${root} (missing ${MANIFEST_FILENAME})`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceManifest;
    assertValid(validateWorkspaceManifest(manifest));

    if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new WorkspaceError(
        `Workspace schema v${manifest.schemaVersion} is newer than this build supports (v${LATEST_SCHEMA_VERSION}). Update ROMLab.`,
      );
    }

    const db = new DatabaseSync(path.join(root, DATABASE_FILENAME));
    db.exec('PRAGMA foreign_keys = ON');
    const version = applyMigrations(db);

    if (version !== manifest.schemaVersion) {
      const migrated: WorkspaceManifest = { ...manifest, schemaVersion: version };
      writeFileSync(manifestPath, `${JSON.stringify(migrated, null, 2)}\n`);
      return new Workspace(root, migrated, db, options.logger ?? silentLogger);
    }

    return new Workspace(root, manifest, db, options.logger ?? silentLogger);
  }

  /** Opens an existing workspace, creating it first if absent. */
  static openOrCreate(root: string, options: { name: string; logger?: Logger }): Workspace {
    return existsSync(path.join(root, MANIFEST_FILENAME))
      ? Workspace.open(root, options)
      : Workspace.create(root, options);
  }

  // --- ROMs -----------------------------------------------------------------

  importRom(record: RomRecord): RomRecord {
    assertValid(validateRomRecord(record));

    const existing = this.getRom(record.sha256);
    if (existing) {
      this.logger.info('rom already imported', { sha256: record.sha256 });
      return existing;
    }

    this.db
      .prepare(
        `INSERT INTO rom (sha256, sha1, platform, byte_length, source_format, source_path, imported_at, header_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sha256,
        record.sha1,
        record.platform,
        record.byteLength,
        record.sourceFormat,
        record.sourcePath,
        record.importedAt,
        JSON.stringify(record.header),
      );

    this.logger.info('rom imported', { sha256: record.sha256, platform: record.platform });
    return record;
  }

  getRom(sha256: string): RomRecord | undefined {
    const row = this.db.prepare('SELECT * FROM rom WHERE sha256 = ?').get(sha256) as
      | RomRow
      | undefined;
    return row ? rowToRom(row) : undefined;
  }

  listRoms(): RomRecord[] {
    const rows = this.db.prepare('SELECT * FROM rom ORDER BY imported_at ASC').all() as unknown as RomRow[];
    return rows.map(rowToRom);
  }

  // --- Sessions -------------------------------------------------------------

  startSession(session: Omit<SessionRecord, 'startedAt'> & { startedAt?: string }): SessionRecord {
    if (!this.getRom(session.romSha256)) {
      throw new WorkspaceError(
        `Cannot start a session for ROM ${session.romSha256}: import the ROM first.`,
      );
    }

    const record: SessionRecord = { ...session, startedAt: session.startedAt ?? new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO session (id, rom_sha256, adapter, emulator_json, started_at, ended_at, scenario)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.romSha256,
        record.adapter,
        JSON.stringify(record.emulator),
        record.startedAt,
        record.endedAt ?? null,
        record.scenario ?? null,
      );

    this.logger.info('session started', { id: record.id, adapter: record.adapter });
    return record;
  }

  endSession(id: string, endedAt = new Date().toISOString()): void {
    this.db.prepare('UPDATE session SET ended_at = ? WHERE id = ?').run(endedAt, id);
  }

  logCommands(sessionId: string, entries: readonly CommandLogEntry[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO command_log (session_id, sequence, command_json, frame_before, frame_after, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const entry of entries) {
        insert.run(
          sessionId,
          entry.sequence,
          JSON.stringify(entry.command),
          entry.frameBefore,
          entry.frameAfter,
          entry.at,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getCommandLog(sessionId: string): CommandLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM command_log WHERE session_id = ? ORDER BY sequence ASC')
      .all(sessionId) as unknown as CommandRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      command: JSON.parse(row.command_json) as CommandLogEntry['command'],
      frameBefore: row.frame_before,
      frameAfter: row.frame_after,
      at: row.at,
    }));
  }

  // --- Captures -------------------------------------------------------------

  /**
   * Ingests a runtime capture.
   *
   * A capture is only meaningful against the ROM that produced it, so a
   * manifest whose hash is unknown to this workspace is refused outright
   * rather than stored and quietly mismatched later.
   */
  ingestCapture(manifest: CaptureManifest): CaptureManifest {
    assertValid(validateCaptureManifest(manifest));

    if (!this.getRom(manifest.romSha256)) {
      throw new WorkspaceError(
        `Capture ${manifest.captureId} is pinned to ROM ${manifest.romSha256}, which is not imported in this workspace.`,
      );
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO capture (capture_id, session_id, rom_sha256, frame, scenario, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        manifest.captureId,
        manifest.sessionId,
        manifest.romSha256,
        manifest.frame,
        manifest.scenario ?? null,
        JSON.stringify(manifest),
        manifest.createdAt,
      );

    this.logger.info('capture ingested', {
      captureId: manifest.captureId,
      frame: manifest.frame,
      domains: manifest.domains.length,
    });
    return manifest;
  }

  getCapture(captureId: string): CaptureManifest | undefined {
    const row = this.db
      .prepare('SELECT manifest_json FROM capture WHERE capture_id = ?')
      .get(captureId) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as CaptureManifest) : undefined;
  }

  listCaptures(filter: { sessionId?: string; romSha256?: string } = {}): CaptureManifest[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.romSha256) {
      clauses.push('rom_sha256 = ?');
      params.push(filter.romSha256);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT manifest_json FROM capture${where} ORDER BY frame ASC`)
      .all(...params) as { manifest_json: string }[];
    return rows.map((row) => JSON.parse(row.manifest_json) as CaptureManifest);
  }

  // --- Paths ----------------------------------------------------------------

  capturePath(captureId: string, ...segments: string[]): string {
    return path.join(this.root, 'captures', captureId, ...segments);
  }

  /** Reconstructions and any other ROM-derived media live here, never in exports. */
  privatePath(...segments: string[]): string {
    return path.join(this.root, 'private-repro', ...segments);
  }

  exportPath(...segments: string[]): string {
    return path.join(this.root, 'exports', ...segments);
  }

  close(): void {
    this.db.close();
  }

  /** Escape hatch for the report/export layers, which need read-only SQL. */
  get database(): DatabaseSync {
    return this.db;
  }
}

interface RomRow {
  sha256: string;
  sha1: string;
  platform: string;
  byte_length: number;
  source_format: string;
  source_path: string;
  imported_at: string;
  header_json: string;
}

interface CommandRow {
  sequence: number;
  command_json: string;
  frame_before: number;
  frame_after: number;
  at: string;
}

function rowToRom(row: RomRow): RomRecord {
  return {
    sha256: row.sha256,
    sha1: row.sha1,
    platform: row.platform as RomRecord['platform'],
    byteLength: row.byte_length,
    sourceFormat: row.source_format,
    sourcePath: row.source_path,
    importedAt: row.imported_at,
    header: JSON.parse(row.header_json) as Record<string, unknown>,
  };
}
