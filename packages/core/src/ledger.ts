import type { DatabaseSync } from 'node:sqlite';

import {
  EVIDENCE_SCHEMA_ID,
  SchemaViolation,
  assertValid,
  auditEvidenceRecord,
  validateEvidenceRecord,
  verificationRank,
  type AuditIssue,
  type EvidenceInput,
  type EvidenceRecord,
  type FindingKind,
  type VerificationState,
} from '@romlab/schema';

import { hashRecord } from './hash.js';

export const GENESIS_HASH = '0'.repeat(64);

export class EvidenceRejected extends Error {
  constructor(readonly issues: AuditIssue[]) {
    super(
      `Evidence rejected by auditor:\n  - ${issues.map((i) => `[${i.rule}] ${i.message}`).join('\n  - ')}`,
    );
    this.name = 'EvidenceRejected';
  }
}

export interface EvidenceQuery {
  romSha256?: string;
  kind?: FindingKind;
  minVerification?: VerificationState;
  captureId?: string;
}

/**
 * Append-only evidence ledger.
 *
 * Each row commits to the one before it, so a workspace can prove that its
 * findings were not quietly rewritten after a report was published. Combined
 * with the auditor, this is what lets a reader trust a tier label.
 */
export class EvidenceLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  append(input: EvidenceInput): EvidenceRecord {
    const record: EvidenceRecord = {
      ...input,
      schema: EVIDENCE_SCHEMA_ID,
      id: input.id ?? this.nextId(),
      createdAt: input.createdAt ?? this.now(),
    };

    assertValid(validateEvidenceRecord(record));

    const issues = auditEvidenceRecord(record);
    if (issues.length > 0) throw new EvidenceRejected(issues);

    const prevHash = this.headHash();
    const recordHash = hashRecord({ prevHash, record });

    this.db
      .prepare(
        `INSERT INTO evidence
           (id, rom_sha256, kind, subject, origin, verification, confidence,
            capture_id, frame, record_json, prev_hash, record_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.romSha256,
        record.kind,
        record.subject,
        record.origin,
        record.verification,
        record.confidence,
        record.locator.captureId ?? null,
        record.locator.frame ?? null,
        JSON.stringify(record),
        prevHash,
        recordHash,
        record.createdAt,
      );

    return record;
  }

  /** Appends many records atomically; one rejection aborts the whole batch. */
  appendAll(inputs: readonly EvidenceInput[]): EvidenceRecord[] {
    this.db.exec('BEGIN');
    try {
      const written = inputs.map((input) => this.append(input));
      this.db.exec('COMMIT');
      return written;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: string): EvidenceRecord | undefined {
    const row = this.db.prepare('SELECT record_json FROM evidence WHERE id = ?').get(id) as
      | { record_json: string }
      | undefined;
    return row ? (JSON.parse(row.record_json) as EvidenceRecord) : undefined;
  }

  query(filter: EvidenceQuery = {}): EvidenceRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter.romSha256) {
      clauses.push('rom_sha256 = ?');
      params.push(filter.romSha256);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.captureId) {
      clauses.push('capture_id = ?');
      params.push(filter.captureId);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT record_json FROM evidence${where} ORDER BY seq ASC`)
      .all(...params) as { record_json: string }[];

    let records = rows.map((row) => JSON.parse(row.record_json) as EvidenceRecord);

    if (filter.minVerification) {
      const floor = verificationRank(filter.minVerification);
      records = records.filter((r) => verificationRank(r.verification) >= floor);
    }

    return records;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number };
    return row.n;
  }

  headHash(): string {
    const row = this.db
      .prepare('SELECT record_hash FROM evidence ORDER BY seq DESC LIMIT 1')
      .get() as { record_hash: string } | undefined;
    return row?.record_hash ?? GENESIS_HASH;
  }

  /**
   * Recomputes the chain. Returns the first inconsistency, if any — used by
   * `romlab audit` and before every export.
   */
  verifyChain(): { ok: true } | { ok: false; brokenAt: string; reason: string } {
    const rows = this.db
      .prepare('SELECT id, record_json, prev_hash, record_hash FROM evidence ORDER BY seq ASC')
      .all() as { id: string; record_json: string; prev_hash: string; record_hash: string }[];

    let expectedPrev = GENESIS_HASH;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return { ok: false, brokenAt: row.id, reason: 'prev_hash does not match preceding record' };
      }
      const record = JSON.parse(row.record_json) as EvidenceRecord;
      const recomputed = hashRecord({ prevHash: row.prev_hash, record });
      if (recomputed !== row.record_hash) {
        return { ok: false, brokenAt: row.id, reason: 'record content does not match its hash' };
      }
      expectedPrev = row.record_hash;
    }

    return { ok: true };
  }

  private nextId(): string {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM evidence').get() as {
      n: number;
    };
    return `ev-${String(row.n + 1).padStart(6, '0')}`;
  }
}

export { SchemaViolation };
