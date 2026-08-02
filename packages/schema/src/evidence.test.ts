import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVIDENCE_SCHEMA_ID,
  auditAll,
  auditEvidenceRecord,
  validateEvidenceRecord,
  type EvidenceRecord,
} from './evidence.js';
import { MAX_TIER_BY_ORIGIN, isPromotion, verificationRank } from './verification.js';

const ROM = 'a'.repeat(64);

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schema: EVIDENCE_SCHEMA_ID,
    id: 'ev-1',
    romSha256: ROM,
    kind: 'graphics_candidate',
    subject: 'tile bank candidate',
    origin: 'static_analysis',
    verification: 'unverified_candidate',
    confidence: 0.4,
    locator: { romOffset: 0x1000, romLength: 0x400 },
    producer: { name: 'graphics-candidate-hunter', version: '0.2.0' },
    transformations: [{ name: 'decode:4bpp', version: '1' }],
    derivedFrom: [],
    data: {},
    createdAt: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

describe('evidence record validation', () => {
  it('accepts a well-formed candidate record', () => {
    const result = validateEvidenceRecord(record());
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('rejects a confidence outside [0, 1]', () => {
    const result = validateEvidenceRecord(record({ confidence: 1.5 }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('confidence')));
  });

  it('rejects a record that is not anchored to a ROM hash', () => {
    const result = validateEvidenceRecord(record({ romSha256: 'not-a-hash' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('romSha256')));
  });
});

describe('evidence auditor', () => {
  it('passes a static candidate that stays a candidate', () => {
    assert.deepEqual(auditEvidenceRecord(record()), []);
  });

  it('refuses to let static analysis claim a runtime observation', () => {
    const issues = auditEvidenceRecord(
      record({ verification: 'runtime_observed', locator: { captureId: 'c1', frame: 10 } }),
    );
    const rules = issues.map((i) => i.rule);
    assert.ok(rules.includes('origin_tier_ceiling'));
    assert.ok(rules.includes('static_is_candidate_only'));
  });

  it('requires a capture id and frame for runtime observations', () => {
    const issues = auditEvidenceRecord(
      record({
        origin: 'runtime_capture',
        verification: 'runtime_observed',
        kind: 'sprite_reconstruction',
        locator: { domain: 'VRAM', domainStart: 0 },
      }),
    );
    const rules = issues.map((i) => i.rule);
    assert.ok(rules.includes('runtime_requires_capture'));
    assert.ok(rules.includes('runtime_requires_frame'));
  });

  it('accepts a runtime observation that cites its capture and frame', () => {
    const issues = auditEvidenceRecord(
      record({
        origin: 'runtime_capture',
        verification: 'runtime_observed',
        kind: 'sprite_reconstruction',
        locator: { captureId: 'cap-7', frame: 182441, domain: 'VRAM', domainStart: 0x7200 },
        transformations: [{ name: 'vdp:reconstruct-sprites', version: '0.2.0' }],
      }),
    );
    assert.deepEqual(issues, []);
  });

  it('requires two independent observations before claiming reproduction', () => {
    const issues = auditEvidenceRecord(
      record({
        origin: 'controlled_experiment',
        verification: 'reproduced',
        locator: { captureId: 'cap-7', frame: 100 },
        derivedFrom: ['ev-obs-1'],
        transformations: [{ name: 'experiment:repeat', version: '1' }],
      }),
    );
    assert.ok(issues.some((i) => i.rule === 'reproduced_requires_two_observations'));
  });

  it('requires a recorded experiment before claiming mechanical verification', () => {
    const issues = auditEvidenceRecord(
      record({
        origin: 'controlled_experiment',
        verification: 'mechanically_verified',
        kind: 'ram_variable',
        locator: { captureId: 'cap-7', frame: 100, domain: '68K RAM', domainStart: 0xff1234 },
        derivedFrom: ['ev-a', 'ev-b'],
        transformations: [{ name: 'diff:ram-search', version: '1' }],
      }),
    );
    assert.ok(issues.some((i) => i.rule === 'mechanical_requires_experiment'));
  });

  it('accepts a mechanically verified variable backed by a freeze experiment', () => {
    const issues = auditEvidenceRecord(
      record({
        origin: 'controlled_experiment',
        verification: 'mechanically_verified',
        kind: 'ram_variable',
        subject: 'stamina (player)',
        locator: { captureId: 'cap-7', frame: 100, domain: '68K RAM', domainStart: 0xff1234 },
        derivedFrom: ['ev-a', 'ev-b'],
        transformations: [
          { name: 'diff:ram-search', version: '1' },
          { name: 'experiment:freeze-and-observe', version: '1' },
        ],
      }),
    );
    assert.deepEqual(issues, []);
  });

  it('rejects a finding with no locator at all', () => {
    const issues = auditEvidenceRecord(record({ locator: {} }));
    assert.ok(issues.some((i) => i.rule === 'locator_required'));
  });

  it('blocks laundering a candidate into an observation through lineage', () => {
    const candidate = record({ id: 'ev-candidate' });
    const laundered = record({
      id: 'ev-laundered',
      origin: 'runtime_reconstruction',
      verification: 'runtime_observed',
      locator: { captureId: 'cap-1', frame: 5 },
      derivedFrom: ['ev-candidate'],
    });

    const issues = auditAll([candidate, laundered]);
    assert.ok(issues.some((i) => i.rule === 'lineage_tier_monotonic' && i.recordId === 'ev-laundered'));
  });
});

describe('verification tiers', () => {
  it('orders tiers from candidate to human confirmed', () => {
    assert.ok(verificationRank('unverified_candidate') < verificationRank('runtime_observed'));
    assert.ok(verificationRank('reproduced') < verificationRank('mechanically_verified'));
    assert.ok(verificationRank('mechanically_verified') < verificationRank('human_confirmed'));
  });

  it('treats a downgrade as not a promotion', () => {
    assert.equal(isPromotion('runtime_observed', 'unverified_candidate'), false);
    assert.equal(isPromotion('unverified_candidate', 'runtime_observed'), true);
  });

  it('caps every static-flavoured origin at candidate', () => {
    assert.equal(MAX_TIER_BY_ORIGIN.static_analysis, 'unverified_candidate');
    assert.equal(MAX_TIER_BY_ORIGIN.imported_manifest, 'unverified_candidate');
  });
});
