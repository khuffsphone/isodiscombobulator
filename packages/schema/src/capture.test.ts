import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAPTURE_SCHEMA_ID,
  findDomain,
  validateCaptureManifest,
  type CaptureManifest,
} from './capture.js';

const ROM = 'b'.repeat(64);
const HASH = 'c'.repeat(64);

function manifest(overrides: Partial<CaptureManifest> = {}): CaptureManifest {
  return {
    schema: CAPTURE_SCHEMA_ID,
    captureId: 'cap-0001',
    sessionId: 'sess-0001',
    romSha256: ROM,
    emulator: { name: 'BizHawk', version: '2.9.1', core: 'Genplus-gx' },
    frame: 182441,
    input: { ports: [['Left', 'A'], []] },
    domains: [{ domain: 'VRAM', start: 0, length: 65536, sha256: HASH }],
    artifacts: [{ kind: 'screenshot', path: 'captures/cap-0001/frame.png', sha256: HASH }],
    createdAt: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

describe('romlab.capture.v1', () => {
  it('accepts a synchronised capture', () => {
    const result = validateCaptureManifest(manifest());
    assert.deepEqual(result.errors, []);
  });

  it('rejects a foreign schema id', () => {
    const result = validateCaptureManifest(manifest({ schema: 'romlab.capture.v2' as never }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('schema')));
  });

  it('requires a well-formed ROM hash', () => {
    const result = validateCaptureManifest(manifest({ romSha256: 'deadbeef' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('romSha256')));
  });

  it('rejects an unknown memory domain', () => {
    const result = validateCaptureManifest(
      manifest({ domains: [{ domain: 'GPU RAM' as never, start: 0, length: 16, sha256: HASH }] }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('domains[0].domain')));
  });

  it('requires every artifact to carry a content hash', () => {
    const result = validateCaptureManifest(
      manifest({ artifacts: [{ kind: 'screenshot', path: 'a.png', sha256: 'nope' }] }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('artifacts[0].sha256')));
  });

  it('looks up a captured domain by name', () => {
    assert.equal(findDomain(manifest(), 'VRAM')?.length, 65536);
    assert.equal(findDomain(manifest(), 'CRAM'), undefined);
  });
});
