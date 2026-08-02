import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  CAPTURE_SCHEMA_ID,
  type CaptureManifest,
  type EvidenceInput,
  type RomRecord,
} from '@romlab/schema';

import { buildExportPackage, assertPrivateDestination, findLeakedPaths } from './export.js';
import { EvidenceRejected } from './ledger.js';
import { Workspace } from './workspace.js';

const ROM_SHA = 'd'.repeat(64);
const OTHER_ROM_SHA = 'e'.repeat(64);
const HASH = 'f'.repeat(64);

const tempRoots: string[] = [];

function newWorkspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), 'romlab-test-'));
  tempRoots.push(root);
  return Workspace.create(root, { name: 'EHRDB investigation' });
}

function rom(overrides: Partial<RomRecord> = {}): RomRecord {
  return {
    sha256: ROM_SHA,
    sha1: '1'.repeat(40),
    platform: 'genesis',
    byteLength: 1024 * 1024,
    sourceFormat: 'bin',
    sourcePath: '/home/operator/roms/ehrdb.bin',
    importedAt: '2026-08-02T00:00:00Z',
    header: { serial: 'GM 00001009-00', region: 'JUE' },
    ...overrides,
  };
}

function capture(overrides: Partial<CaptureManifest> = {}): CaptureManifest {
  return {
    schema: CAPTURE_SCHEMA_ID,
    captureId: 'cap-0001',
    sessionId: 'sess-0001',
    romSha256: ROM_SHA,
    emulator: { name: 'BizHawk', version: '2.9.1', core: 'Genplus-gx' },
    frame: 1200,
    domains: [{ domain: 'VRAM', start: 0, length: 65536, sha256: HASH, path: 'captures/cap-0001/vram.bin' }],
    artifacts: [{ kind: 'screenshot', path: 'captures/cap-0001/frame.png', sha256: HASH }],
    createdAt: '2026-08-02T00:01:00Z',
    ...overrides,
  };
}

function candidate(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    romSha256: ROM_SHA,
    kind: 'graphics_candidate',
    subject: 'tile bank candidate @ 0x1000',
    origin: 'static_analysis',
    verification: 'unverified_candidate',
    confidence: 0.35,
    locator: { romOffset: 0x1000, romLength: 0x400 },
    producer: { name: 'graphics-candidate-hunter', version: '0.2.0' },
    transformations: [{ name: 'decode:4bpp', version: '1' }],
    derivedFrom: [],
    data: {},
    ...overrides,
  };
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('workspace lifecycle', () => {
  it('creates, closes and reopens a workspace', () => {
    const ws = newWorkspace();
    const root = ws.root;
    ws.importRom(rom());
    ws.close();

    const reopened = Workspace.open(root);
    assert.equal(reopened.listRoms().length, 1);
    assert.equal(reopened.manifest.name, 'EHRDB investigation');
    reopened.close();
  });

  it('refuses to create a workspace on top of an existing one', () => {
    const ws = newWorkspace();
    assert.throws(() => Workspace.create(ws.root, { name: 'second' }), /already exists/);
    ws.close();
  });

  it('is idempotent when the same ROM is imported twice', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    ws.importRom(rom());
    assert.equal(ws.listRoms().length, 1);
    ws.close();
  });
});

describe('capture ingestion', () => {
  it('refuses a capture pinned to an unknown ROM', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    assert.throws(
      () => ws.ingestCapture(capture({ romSha256: OTHER_ROM_SHA })),
      /not imported in this workspace/,
    );
    ws.close();
  });

  it('stores and reads back a capture', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    ws.startSession({
      id: 'sess-0001',
      romSha256: ROM_SHA,
      adapter: 'mock',
      emulator: { name: 'BizHawk', version: '2.9.1', core: 'Genplus-gx' },
    });
    ws.ingestCapture(capture());

    assert.equal(ws.getCapture('cap-0001')?.frame, 1200);
    assert.equal(ws.listCaptures({ sessionId: 'sess-0001' }).length, 1);
    ws.close();
  });

  it('refuses a session for a ROM that was never imported', () => {
    const ws = newWorkspace();
    assert.throws(
      () =>
        ws.startSession({
          id: 's',
          romSha256: ROM_SHA,
          adapter: 'mock',
          emulator: { name: 'BizHawk', version: '2.9.1', core: 'Genplus-gx' },
        }),
      /import the ROM first/,
    );
    ws.close();
  });
});

describe('evidence ledger', () => {
  it('appends candidates and chains their hashes', () => {
    const ws = newWorkspace();
    ws.importRom(rom());

    const first = ws.ledger.append(candidate());
    const second = ws.ledger.append(candidate({ subject: 'tile bank candidate @ 0x2000' }));

    assert.equal(ws.ledger.count(), 2);
    assert.notEqual(first.id, second.id);
    assert.equal(ws.ledger.verifyChain().ok, true);
    ws.close();
  });

  it('rejects a static finding that claims a runtime tier', () => {
    const ws = newWorkspace();
    ws.importRom(rom());

    assert.throws(
      () =>
        ws.ledger.append(
          candidate({ verification: 'runtime_observed', locator: { captureId: 'cap-1', frame: 3 } }),
        ),
      EvidenceRejected,
    );
    assert.equal(ws.ledger.count(), 0);
    ws.close();
  });

  it('accepts a runtime reconstruction that cites its capture and frame', () => {
    const ws = newWorkspace();
    ws.importRom(rom());

    const record = ws.ledger.append(
      candidate({
        kind: 'sprite_reconstruction',
        subject: 'Player Boxer — Lead Hook — Frame 4',
        origin: 'runtime_reconstruction',
        verification: 'runtime_observed',
        confidence: 0.9,
        locator: { captureId: 'cap-0001', frame: 182441, domain: 'VRAM', domainStart: 0x7200 },
        transformations: [{ name: 'vdp:reconstruct-sprites', version: '0.2.0' }],
      }),
    );

    assert.equal(record.verification, 'runtime_observed');
    assert.equal(ws.ledger.verifyChain().ok, true);
    ws.close();
  });

  it('detects tampering with a stored record', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    const record = ws.ledger.append(candidate());

    // Simulate an out-of-band edit that promotes a candidate to an observation.
    const forged = JSON.stringify({ ...record, verification: 'human_confirmed' });
    ws.database.prepare('UPDATE evidence SET record_json = ? WHERE id = ?').run(forged, record.id);

    const chain = ws.ledger.verifyChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.ok === false && chain.brokenAt, record.id);
    ws.close();
  });

  it('rolls the whole batch back when one record is rejected', () => {
    const ws = newWorkspace();
    ws.importRom(rom());

    assert.throws(
      () =>
        ws.ledger.appendAll([
          candidate(),
          candidate({ verification: 'mechanically_verified', locator: { romOffset: 1 } }),
        ]),
      EvidenceRejected,
    );

    assert.equal(ws.ledger.count(), 0);
    ws.close();
  });

  it('filters by minimum verification tier', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    ws.ledger.append(candidate());
    ws.ledger.append(
      candidate({
        kind: 'sprite_reconstruction',
        origin: 'runtime_reconstruction',
        verification: 'runtime_observed',
        locator: { captureId: 'cap-0001', frame: 10 },
        transformations: [{ name: 'vdp:reconstruct-sprites', version: '0.2.0' }],
      }),
    );

    assert.equal(ws.ledger.query({ minVerification: 'runtime_observed' }).length, 1);
    assert.equal(ws.ledger.query().length, 2);
    ws.close();
  });
});

describe('export boundary', () => {
  it('keeps the operator ROM path and capture dumps out of a public package', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    ws.startSession({
      id: 'sess-0001',
      romSha256: ROM_SHA,
      adapter: 'mock',
      emulator: { name: 'BizHawk', version: '2.9.1', core: 'Genplus-gx' },
    });
    ws.ingestCapture(capture());
    ws.ledger.append(
      candidate({ locator: { romOffset: 0x1000, artifactPath: 'private-repro/tile-0.png' } }),
    );

    const pkg = buildExportPackage(ws, { mode: 'public', romSha256: ROM_SHA });
    const serialised = JSON.stringify(pkg);

    assert.equal(pkg.rom.sourcePath, undefined);
    assert.ok(!serialised.includes('/home/operator/roms/ehrdb.bin'));
    assert.ok(!serialised.includes('vram.bin'));
    assert.ok(!serialised.includes('frame.png'));
    assert.deepEqual(findLeakedPaths(pkg), []);

    // Hashes survive, so a private holder can prove the two refer to the same bytes.
    assert.equal(pkg.captures[0]?.domains[0]?.sha256, HASH);
    ws.close();
  });

  it('keeps full detail in a private research package', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    ws.startSession({
      id: 'sess-0001',
      romSha256: ROM_SHA,
      adapter: 'mock',
      emulator: { name: 'BizHawk', version: '2.9.1', core: 'Genplus-gx' },
    });
    ws.ingestCapture(capture());

    const pkg = buildExportPackage(ws, {
      mode: 'private_research',
      romSha256: ROM_SHA,
      destination: ws.privatePath('export'),
    });

    assert.equal(pkg.rom.sourcePath, '/home/operator/roms/ehrdb.bin');
    assert.ok(JSON.stringify(pkg).includes('vram.bin'));
    ws.close();
  });

  it('refuses a private export outside a private-repro directory', () => {
    assert.throws(() => assertPrivateDestination('/tmp/somewhere/public'), /private-repro/);
    assert.doesNotThrow(() => assertPrivateDestination('/tmp/ws/private-repro/export'));
  });

  it('reports ledger integrity alongside the package', () => {
    const ws = newWorkspace();
    ws.importRom(rom());
    ws.ledger.append(candidate());

    const pkg = buildExportPackage(ws, { mode: 'public', romSha256: ROM_SHA });
    assert.equal(pkg.audit.ledgerIntact, true);
    assert.deepEqual(pkg.audit.issues, []);
    ws.close();
  });
});
