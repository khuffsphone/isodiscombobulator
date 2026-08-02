import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Workspace } from '@romlab/core';
import { SYNTHETIC_SAT_START, buildSyntheticRom, isPng } from '@romlab/platform-genesis';
import { verificationRank } from '@romlab/schema';

import { run } from './index.js';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'romlab-e2e-'));
  tempRoots.push(root);
  return root;
}

/** Captures stdout so command output can be asserted on. */
async function runQuiet(argv: string[]): Promise<{ code: number; stdout: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let stdout = '';

  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    stdout += String(chunk);
    return true;
  };

  try {
    const code = await run(argv);
    return { code, stdout };
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
}

interface Fixture {
  workspaceDir: string;
  romPath: string;
}

function fixture(): Fixture {
  const root = scratch();
  const workspaceDir = path.join(root, 'workspace');
  const romPath = path.join(root, 'fixture.bin');
  writeFileSync(romPath, buildSyntheticRom({ byteLength: 128 * 1024 }));
  return { workspaceDir, romPath };
}

describe('romlab CLI end to end', () => {
  it('runs the full loop: init, import, scan, capture, reconstruct, audit, report, export', async () => {
    const { workspaceDir, romPath } = fixture();

    // 1. Create a workspace.
    assert.equal((await runQuiet(['init', '--workspace', workspaceDir, '--name', 'EHRDB'])).code, 0);

    // 2. Identify the cartridge without copying it in.
    const imported = await runQuiet(['import', '--workspace', workspaceDir, '--rom-path', romPath]);
    assert.equal(imported.code, 0);
    assert.match(imported.stdout, /checksum matches header/);

    // 3. Static scan — candidates only.
    const scanned = await runQuiet(['scan', '--workspace', workspaceDir, '--rom-path', romPath]);
    assert.equal(scanned.code, 0);
    assert.match(scanned.stdout, /unverified candidates/);

    // 4. Drive the emulator adapter and capture a synchronised frame.
    const captured = await runQuiet([
      'capture',
      '--workspace', workspaceDir,
      '--rom-path', romPath,
      '--adapter', 'mock',
      '--session', 'sess-e2e',
      '--scenario', 'standing-jab',
      '--steps', 'advance:60,press:A+Right:10,advance:2',
      '--domains', 'VRAM,CRAM,68K RAM',
      '--screenshot',
      '--savestate', 'jab-contact',
    ]);
    assert.equal(captured.code, 0);
    // 60 advance + 10 held + 2 advance; releasing input costs no frames.
    assert.match(captured.stdout, /Captured cap-0001 at frame 72/);

    // 5. Reconstruct on-screen objects from the captured VDP state.
    const reconstructed = await runQuiet([
      'reconstruct',
      '--workspace', workspaceDir,
      '--capture', 'cap-0001',
      '--sat-start', `0x${SYNTHETIC_SAT_START.toString(16)}`,
      '--write-images',
    ]);
    assert.equal(reconstructed.code, 0);
    assert.match(reconstructed.stdout, /Reconstructed 1 object/);
    assert.match(reconstructed.stdout, /24x16/);

    const png = path.join(workspaceDir, 'private-repro', 'reconstructions', 'cap-0001', 'object-00.png');
    assert.ok(existsSync(png), 'reconstruction PNG should be written under private-repro');
    assert.ok(isPng(new Uint8Array(readFileSync(png))));

    // 6. The auditor must be clean and the ledger chain intact.
    const audited = await runQuiet(['audit', '--workspace', workspaceDir]);
    assert.equal(audited.code, 0);
    assert.match(audited.stdout, /Chain intact: yes/);
    assert.match(audited.stdout, /Auditor issues: 0/);

    // 7. The report separates tiers and names the frame evidence rests on.
    const reportPath = path.join(workspaceDir, 'exports', 'report.md');
    assert.equal(
      (await runQuiet(['report', '--workspace', workspaceDir, '--out', reportPath])).code,
      0,
    );
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Runtime observed \| 1/);
    assert.match(report, /frame 72/);
    assert.match(report, /Ledger chain intact: yes/);

    // 8. A public export must carry no ROM-derived media.
    const exportPath = path.join(workspaceDir, 'exports', 'public.json');
    assert.equal(
      (await runQuiet(['export', '--workspace', workspaceDir, '--out', exportPath])).code,
      0,
    );

    const pkg = JSON.parse(readFileSync(exportPath, 'utf8')) as Record<string, unknown>;
    const serialised = JSON.stringify(pkg);
    assert.equal((pkg['rom'] as Record<string, unknown>)['sourcePath'], undefined);
    assert.ok(!serialised.includes(romPath));
    assert.ok(!serialised.includes('.png'));
    assert.ok(!serialised.includes('private-repro'));
    assert.ok(!serialised.includes('vram-0.bin'));
  });

  it('keeps static findings at candidate tier and runtime findings above it', async () => {
    const { workspaceDir, romPath } = fixture();

    await runQuiet(['init', '--workspace', workspaceDir, '--name', 'tiers']);
    await runQuiet(['scan', '--workspace', workspaceDir, '--rom-path', romPath]);
    await runQuiet([
      'capture',
      '--workspace', workspaceDir,
      '--rom-path', romPath,
      '--steps', 'advance:10',
      '--domains', 'VRAM,CRAM',
    ]);
    await runQuiet([
      'reconstruct',
      '--workspace', workspaceDir,
      '--capture', 'cap-0001',
      '--sat-start', String(SYNTHETIC_SAT_START),
    ]);

    const workspace = Workspace.open(workspaceDir);
    const records = workspace.ledger.query();

    const staticRecords = records.filter((r) => r.origin === 'static_analysis');
    assert.ok(staticRecords.length > 0);
    assert.ok(staticRecords.every((r) => r.verification === 'unverified_candidate'));

    const runtimeRecords = records.filter((r) => r.origin === 'runtime_reconstruction');
    assert.ok(runtimeRecords.length > 0);
    assert.ok(
      runtimeRecords.every(
        (r) =>
          verificationRank(r.verification) >= verificationRank('runtime_observed') &&
          r.locator.captureId !== undefined &&
          r.locator.frame !== undefined,
      ),
    );

    workspace.close();
  });

  it('refuses to reconstruct without an explicit sprite table address', async () => {
    const { workspaceDir, romPath } = fixture();

    await runQuiet(['init', '--workspace', workspaceDir, '--name', 'no-guessing']);
    await runQuiet([
      'capture',
      '--workspace', workspaceDir,
      '--rom-path', romPath,
      '--steps', 'advance:1',
      '--domains', 'VRAM,CRAM',
    ]);

    const result = await runQuiet(['reconstruct', '--workspace', workspaceDir, '--capture', 'cap-0001']);
    assert.equal(result.code, 2);
  });

  it('refuses to reconstruct when a dump no longer matches its recorded hash', async () => {
    const { workspaceDir, romPath } = fixture();

    await runQuiet(['init', '--workspace', workspaceDir, '--name', 'tamper']);
    await runQuiet([
      'capture',
      '--workspace', workspaceDir,
      '--rom-path', romPath,
      '--steps', 'advance:1',
      '--domains', 'VRAM,CRAM',
    ]);

    // Corrupt the VRAM dump after the manifest recorded its hash.
    const workspace = Workspace.open(workspaceDir);
    const vramPath = path.join(workspace.root, workspace.getCapture('cap-0001')!.domains[0]!.path!);
    workspace.close();

    const bytes = readFileSync(vramPath);
    bytes[0] = (bytes[0]! + 1) & 0xff;
    writeFileSync(vramPath, bytes);

    const result = await runQuiet([
      'reconstruct',
      '--workspace', workspaceDir,
      '--capture', 'cap-0001',
      '--sat-start', String(SYNTHETIC_SAT_START),
    ]);
    assert.equal(result.code, 1);
  });

  it('reports usage errors without a stack trace', async () => {
    assert.equal((await runQuiet(['init'])).code, 2);
    assert.equal((await runQuiet(['nonsense'])).code, 2);
    assert.equal((await runQuiet(['help'])).code, 0);
  });
});
