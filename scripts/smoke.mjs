#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Drives the real `romlab` CLI through the whole loop against a synthetic
 * cartridge, then asserts the two properties that matter most: static findings
 * never rise above candidate tier, and a public export carries no ROM-derived
 * media. Runs in CI on a machine with no ROM and no emulator.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSyntheticRom, SYNTHETIC_SAT_START } from '@romlab/platform-genesis';

const root = mkdtempSync(path.join(tmpdir(), 'romlab-smoke-'));
const workspace = path.join(root, 'workspace');
const romPath = path.join(root, 'fixture.bin');
const cli = path.resolve('packages/cli/dist/bin.js');

let failures = 0;

function check(label, condition) {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}`);
  if (!condition) failures += 1;
}

function romlab(...args) {
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
    encoding: 'utf8',
  });
}

try {
  writeFileSync(romPath, buildSyntheticRom({ byteLength: 128 * 1024 }));

  console.log('romlab end-to-end smoke test');

  romlab('init', '--workspace', workspace, '--name', 'smoke');
  check('workspace created', true);

  const imported = romlab('import', '--workspace', workspace, '--rom-path', romPath);
  check('cartridge identified with a matching checksum', imported.includes('checksum matches header'));

  romlab('scan', '--workspace', workspace, '--rom-path', romPath);

  const captured = romlab(
    'capture',
    '--workspace', workspace,
    '--rom-path', romPath,
    '--adapter', 'mock',
    '--scenario', 'smoke',
    '--steps', 'advance:30,press:A+Right:10',
    '--domains', 'VRAM,CRAM,68K RAM',
    '--screenshot',
  );
  check('synchronised capture recorded', captured.includes('Captured cap-0001 at frame 40'));

  const reconstructed = romlab(
    'reconstruct',
    '--workspace', workspace,
    '--capture', 'cap-0001',
    '--sat-start', `0x${SYNTHETIC_SAT_START.toString(16)}`,
    '--write-images',
  );
  check('object reconstructed from runtime VDP state', reconstructed.includes('Reconstructed 1 object'));

  const audited = romlab('audit', '--workspace', workspace);
  check('evidence ledger intact', audited.includes('Chain intact: yes'));
  check('auditor reports no violations', audited.includes('Auditor issues: 0'));

  const exportPath = path.join(root, 'public.json');
  romlab('export', '--workspace', workspace, '--out', exportPath);

  const pkg = readFileSync(exportPath, 'utf8');
  const parsed = JSON.parse(pkg);

  check('public export omits the operator ROM path', !pkg.includes(romPath));
  check('public export omits reconstructions', !pkg.includes('private-repro'));
  check('public export omits raw dumps', !pkg.includes('.bin'));
  check(
    'static findings stay at candidate tier',
    parsed.evidence
      .filter((record) => record.origin === 'static_analysis')
      .every((record) => record.verification === 'unverified_candidate'),
  );
  check(
    'runtime findings cite a capture and a frame',
    parsed.evidence
      .filter((record) => record.origin === 'runtime_reconstruction')
      .every((record) => record.locator.captureId && record.locator.frame !== undefined),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}

console.log('\nAll smoke checks passed.');
