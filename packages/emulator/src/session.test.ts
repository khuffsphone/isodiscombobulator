import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Workspace, sha256 } from '@romlab/core';
import { buildSyntheticRom, identifyRom } from '@romlab/platform-genesis';

import { RomIdentityMismatch } from './adapter.js';
import { MOCK_STAMINA_ADDRESS, MockGenesisAdapter } from './mock.js';
import { CaptureSession } from './session.js';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'romlab-session-'));
  tempRoots.push(root);

  const workspace = Workspace.create(root, { name: 'session test' });
  const rom = identifyRom(buildSyntheticRom({ byteLength: 64 * 1024 }), {
    sourcePath: '/roms/fixture.bin',
    importedAt: '2026-08-02T00:00:00Z',
  });
  workspace.importRom(rom.record);

  return { workspace, romSha256: rom.record.sha256 };
}

async function openSession(
  workspace: Workspace,
  romSha256: string,
  sessionId = 'sess-0001',
): Promise<CaptureSession> {
  return CaptureSession.open({
    workspace,
    adapter: new MockGenesisAdapter({ romSha256 }),
    romSha256,
    sessionId,
    scenario: 'standing-jab',
    now: () => '2026-08-02T00:00:00Z',
    connect: { romPath: '/roms/fixture.bin', romSha256 },
  });
}

describe('capture session', () => {
  it('refuses to attach to an emulator running a different ROM', async () => {
    const { workspace, romSha256 } = setup();
    const adapter = new MockGenesisAdapter({ romSha256: 'a'.repeat(64) });

    await assert.rejects(
      () =>
        CaptureSession.open({
          workspace,
          adapter,
          romSha256,
          sessionId: 'sess-x',
          connect: { romPath: '/roms/fixture.bin', romSha256 },
        }),
      RomIdentityMismatch,
    );

    workspace.close();
  });

  it('advances frames and records a reproducible command log', async () => {
    const { workspace, romSha256 } = setup();
    const session = await openSession(workspace, romSha256);

    await session.advance(10);
    await session.press(['A'], 5);

    assert.equal(session.currentFrame, 15);
    await session.close();

    const log = workspace.getCommandLog('sess-0001');
    assert.equal(log.length, session.log.length);
    assert.equal(log[0]?.command.op, 'advance');
    assert.equal(log[0]?.frameBefore, 0);
    assert.equal(log[0]?.frameAfter, 10);

    workspace.close();
  });

  it('writes a synchronised capture and ingests its manifest', async () => {
    const { workspace, romSha256 } = setup();
    const session = await openSession(workspace, romSha256);

    await session.advance(120);
    const manifest = await session.capture({
      scenario: 'standing-jab',
      screenshot: true,
      savestateLabel: 'jab-contact',
      domains: [
        { domain: 'VRAM', length: 0x10000 },
        { domain: 'CRAM', length: 128 },
        { domain: '68K RAM', length: 0x2000 },
      ],
    });

    assert.equal(manifest.frame, 120);
    assert.equal(manifest.romSha256, romSha256);
    assert.equal(manifest.domains.length, 3);
    assert.ok(manifest.savestateSha256);
    assert.equal(manifest.artifacts.find((a) => a.kind === 'screenshot')?.width, 320);

    // The raw dumps must be on disk and hash-matched to the manifest.
    const vram = manifest.domains.find((d) => d.domain === 'VRAM')!;
    assert.ok(existsSync(path.join(workspace.root, vram.path!)));

    assert.ok(workspace.getCapture(manifest.captureId));
    await session.close();
    workspace.close();
  });

  it('produces identical captures for identical command sequences', async () => {
    const first = setup();
    const firstSession = await openSession(first.workspace, first.romSha256);
    await firstSession.press(['A'], 20);
    const a = await firstSession.capture({ domains: [{ domain: '68K RAM', length: 0x2000 }] });
    await firstSession.close();

    const second = setup();
    const secondSession = await openSession(second.workspace, second.romSha256);
    await secondSession.press(['A'], 20);
    const b = await secondSession.capture({ domains: [{ domain: '68K RAM', length: 0x2000 }] });
    await secondSession.close();

    assert.equal(a.domains[0]?.sha256, b.domains[0]?.sha256);
    assert.equal(a.frame, b.frame);

    first.workspace.close();
    second.workspace.close();
  });

  it('restores exact state from a savestate', async () => {
    const { workspace, romSha256 } = setup();
    const session = await openSession(workspace, romSha256);

    await session.advance(30);
    await session.saveState('checkpoint');
    const before = await session.readDomain('68K RAM', 0, 0x2000);

    await session.press(['A'], 20);
    const after = await session.readDomain('68K RAM', 0, 0x2000);
    assert.notEqual(sha256(before), sha256(after));

    await session.loadState('checkpoint');
    const restored = await session.readDomain('68K RAM', 0, 0x2000);
    assert.equal(sha256(restored), sha256(before));
    assert.equal(session.currentFrame, 30);

    await session.close();
    workspace.close();
  });

  it('moves a memory value in response to input, so a RAM search has an answer', async () => {
    const { workspace, romSha256 } = setup();
    const session = await openSession(workspace, romSha256);

    const before = await session.readDomain('68K RAM', 0, 0x2000);
    await session.press(['A'], 10);
    const after = await session.readDomain('68K RAM', 0, 0x2000);

    assert.equal(before[MOCK_STAMINA_ADDRESS], 100);
    assert.ok(after[MOCK_STAMINA_ADDRESS]! < before[MOCK_STAMINA_ADDRESS]!);

    await session.close();
    workspace.close();
  });

  it('reports an error for an unknown savestate rather than silently continuing', async () => {
    const { workspace, romSha256 } = setup();
    const session = await openSession(workspace, romSha256);

    await assert.rejects(() => session.loadState('never-saved'), /no_such_savestate/);

    await session.close();
    workspace.close();
  });
});
