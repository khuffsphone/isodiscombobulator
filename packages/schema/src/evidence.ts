import type { MemoryDomain } from './capture.js';
import {
  EVIDENCE_ORIGINS,
  MAX_TIER_BY_ORIGIN,
  VERIFICATION_STATES,
  verificationRank,
  type EvidenceOrigin,
  type VerificationState,
} from './verification.js';
import {
  ISO_INSTANT_PATTERN,
  SHA256_PATTERN,
  Validator,
  type ValidationResult,
} from './validate.js';

export const EVIDENCE_SCHEMA_ID = 'romlab.evidence.v1' as const;

/**
 * What a finding is about. Kept coarse on purpose — the interesting detail
 * lives in `subject` and `data`, and adding a kind should not require a
 * migration of every existing record.
 */
export const FINDING_KINDS = [
  'cartridge_identity',
  'memory_region',
  'graphics_candidate',
  'palette_candidate',
  'string_candidate',
  'sprite_reconstruction',
  'plane_reconstruction',
  'audio_event',
  'ram_variable',
  'mechanic',
  'divergence',
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * Where in the machine (or the file) a finding came from. Every field is
 * optional because a cartridge-header finding has no frame and a runtime
 * sprite has no file offset — but a finding with *no* locator at all is
 * rejected by the auditor.
 */
export interface EvidenceLocator {
  /** Byte offset in the normalised ROM image. */
  romOffset?: number;
  romLength?: number;
  /** Emulator frame this was observed on. */
  frame?: number;
  domain?: MemoryDomain;
  domainStart?: number;
  domainLength?: number;
  captureId?: string;
  savestateSha256?: string;
  /** Workspace-relative artifact backing the claim (screenshot, PNG, WAV). */
  artifactPath?: string;
}

/** One step of processing applied between raw bytes and the stated finding. */
export interface Transformation {
  name: string;
  version: string;
  params?: Record<string, string | number | boolean>;
}

export interface EvidenceRecord {
  schema: typeof EVIDENCE_SCHEMA_ID;
  id: string;
  /** ROM the finding belongs to. Every record is anchored to an identity. */
  romSha256: string;
  kind: FindingKind;
  /** Short human-readable claim, e.g. "Player Boxer — Lead Hook — Frame 4". */
  subject: string;
  origin: EvidenceOrigin;
  verification: VerificationState;
  /** 0..1. Meaningful only relative to other findings from the same analyzer. */
  confidence: number;
  locator: EvidenceLocator;
  /** Analyzer or decoder that produced this, with its version. */
  producer: { name: string; version: string };
  transformations: Transformation[];
  /**
   * Records this one was derived from. A `reproduced` finding cites the
   * independent observations that agree; a `mechanically_verified` finding
   * cites the experiment that manipulated the value.
   */
  supersedes?: string[];
  derivedFrom: string[];
  data: Record<string, unknown>;
  createdAt: string;
}

export interface EvidenceInput extends Omit<EvidenceRecord, 'schema' | 'id' | 'createdAt'> {
  id?: string;
  createdAt?: string;
}

export function validateEvidenceRecord(value: unknown): ValidationResult {
  const v = new Validator('evidence');
  if (!v.object(value, '')) return v.result();

  if (value['schema'] !== EVIDENCE_SCHEMA_ID) {
    v.fail('schema', `expected "${EVIDENCE_SCHEMA_ID}"`);
  }
  v.string(value['id'], 'id', { min: 1 });
  v.string(value['romSha256'], 'romSha256', { pattern: SHA256_PATTERN });
  v.oneOf(value['kind'], 'kind', FINDING_KINDS);
  v.string(value['subject'], 'subject', { min: 1 });
  v.oneOf(value['origin'], 'origin', EVIDENCE_ORIGINS);
  v.oneOf(value['verification'], 'verification', VERIFICATION_STATES);
  v.string(value['createdAt'], 'createdAt', { pattern: ISO_INSTANT_PATTERN });

  const confidence = value['confidence'];
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    v.fail('confidence', 'expected number in [0, 1]');
  }

  if (v.object(value['producer'], 'producer')) {
    v.string(value['producer']['name'], 'producer.name', { min: 1 });
    v.string(value['producer']['version'], 'producer.version', { min: 1 });
  }

  v.array(value['transformations'], 'transformations');
  v.array(value['derivedFrom'], 'derivedFrom');
  v.object(value['data'], 'data');
  v.object(value['locator'], 'locator');

  return v.result();
}

export interface AuditIssue {
  recordId: string;
  rule: string;
  message: string;
}

/**
 * The evidence auditor.
 *
 * This is the guard the whole product depends on. If it is wrong, ROMLab
 * quietly starts publishing guesses as observations, which is precisely the
 * failure mode the project exists to avoid.
 */
export function auditEvidenceRecord(record: EvidenceRecord): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const push = (rule: string, message: string) => issues.push({ recordId: record.id, rule, message });

  const ceiling = MAX_TIER_BY_ORIGIN[record.origin];
  if (verificationRank(record.verification) > verificationRank(ceiling)) {
    push(
      'origin_tier_ceiling',
      `origin "${record.origin}" cannot assert "${record.verification}" (ceiling: "${ceiling}")`,
    );
  }

  const hasLocator = Object.values(record.locator).some((entry) => entry !== undefined);
  if (!hasLocator) {
    push('locator_required', 'every finding must cite at least one locator');
  }

  // Anything claiming the machine was observed must say which frame, from which
  // capture. "It looked right" is not a frame number.
  if (verificationRank(record.verification) >= verificationRank('runtime_observed')) {
    if (record.locator.captureId === undefined) {
      push('runtime_requires_capture', `"${record.verification}" requires locator.captureId`);
    }
    if (record.locator.frame === undefined) {
      push('runtime_requires_frame', `"${record.verification}" requires locator.frame`);
    }
  }

  // Reproduction means independent agreement, so it must cite the records that agree.
  if (verificationRank(record.verification) >= verificationRank('reproduced')) {
    if (record.derivedFrom.length < 2) {
      push(
        'reproduced_requires_two_observations',
        `"${record.verification}" requires at least two derivedFrom observations`,
      );
    }
  }

  // Mechanical verification means the value was manipulated and the consequence seen.
  if (verificationRank(record.verification) >= verificationRank('mechanically_verified')) {
    const hasExperiment = record.transformations.some((t) => t.name.startsWith('experiment:'));
    if (!hasExperiment) {
      push(
        'mechanical_requires_experiment',
        `"${record.verification}" requires a transformation named "experiment:*"`,
      );
    }
  }

  // Static scanning of cartridge bytes is candidate discovery. Always.
  if (record.origin === 'static_analysis' && record.verification !== 'unverified_candidate') {
    push('static_is_candidate_only', 'static analysis may only produce unverified_candidate');
  }

  if (record.transformations.length === 0 && record.origin !== 'human_annotation') {
    push('transformations_required', 'non-human findings must record how they were produced');
  }

  return issues;
}

export function auditAll(records: readonly EvidenceRecord[]): AuditIssue[] {
  const issues = records.flatMap(auditEvidenceRecord);
  const byId = new Map(records.map((r) => [r.id, r]));

  for (const record of records) {
    for (const parent of record.derivedFrom) {
      const source = byId.get(parent);
      if (!source) continue; // Cross-session lineage is resolved by the workspace, not here.
      if (verificationRank(source.verification) < verificationRank('runtime_observed') &&
          verificationRank(record.verification) >= verificationRank('runtime_observed')) {
        issues.push({
          recordId: record.id,
          rule: 'lineage_tier_monotonic',
          message: `cannot derive "${record.verification}" from candidate-tier record ${parent}`,
        });
      }
    }
  }

  return issues;
}
