import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { Logger, StderrSink, Workspace, buildExportPackage, canonicalJson } from '@romlab/core';
import { BizHawkAdapter, CaptureSession, MockGenesisAdapter, type EmulatorAdapter } from '@romlab/emulator';
import {
  identifyRom,
  reconstructCapture,
  scanRomStatically,
  SYNTHETIC_SAT_START,
} from '@romlab/platform-genesis';
import {
  ROMLAB_VERSION,
  auditAll,
  type GenesisButton,
  type MemoryDomain,
  type RomRecord,
} from '@romlab/schema';

import {
  UsageError,
  boolFlag,
  numberFlag,
  optionalFlag,
  parseArgs,
  parseScenario,
  requireFlag,
  type ParsedArgs,
} from './args.js';
import { renderReport } from './report.js';

const USAGE = `romlab ${ROMLAB_VERSION} — runtime-first ROM investigation

Usage: romlab <command> [options]

  init --workspace <dir> --name <name>
      Create a workspace.

  import --workspace <dir> --rom-path <file>
      Identify a ROM and record it. The ROM is never copied into the workspace.

  scan --workspace <dir> --rom-path <file>
      Run static scanners. Everything produced is an unverified candidate.

  capture --workspace <dir> --rom-path <file> [--rom <sha256>]
          [--adapter mock|bizhawk] [--scenario <name>]
          [--steps "advance:120,press:A+Right:5"]
          [--domains "VRAM,CRAM,68K RAM"] [--screenshot] [--savestate <label>]
          [--session <id>]
      Drive an emulator adapter and record a synchronised capture.

  reconstruct --workspace <dir> --capture <id> --sat-start <addr> [--write-images]
      Rebuild on-screen objects from a capture's VDP state.
      --sat-start comes from VDP register 5; ROMLab will not guess it.

  audit --workspace <dir>
      Re-run the evidence auditor and verify the ledger hash chain.

  report --workspace <dir> [--rom <sha256>] [--out <file>]
      Render a Markdown investigation report.

  export --workspace <dir> [--rom <sha256>] [--mode public|private_research]
         [--out <file>]
      Build an export package. Public packages contain no ROM-derived media.

BizHawk options: --bizhawk <EmuHawk.exe> --external-tool <ROMLab.BizHawk.dll>
                 --bizhawk-version <version> --core <core> --port <n>
`;

export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const logger = new Logger('romlab', new StderrSink(), boolFlag(args, 'verbose') ? 'debug' : 'info');

  try {
    switch (args.command) {
      case 'init':
        return commandInit(args, logger);
      case 'import':
        return commandImport(args, logger);
      case 'scan':
        return commandScan(args, logger);
      case 'capture':
        return await commandCapture(args, logger);
      case 'reconstruct':
        return commandReconstruct(args, logger);
      case 'audit':
        return commandAudit(args);
      case 'report':
        return commandReport(args);
      case 'export':
        return commandExport(args);
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        return 0;
      default:
        process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function openWorkspace(args: ParsedArgs, logger: Logger): Workspace {
  return Workspace.open(requireFlag(args, 'workspace'), { logger });
}

function commandInit(args: ParsedArgs, logger: Logger): number {
  const root = requireFlag(args, 'workspace');
  mkdirSync(root, { recursive: true });

  const workspace = Workspace.create(root, { name: requireFlag(args, 'name'), logger });
  process.stdout.write(`Created workspace "${workspace.manifest.name}" at ${workspace.root}\n`);
  workspace.close();
  return 0;
}

function loadRom(args: ParsedArgs): { record: RomRecord; bytes: Uint8Array } {
  const romPath = path.resolve(requireFlag(args, 'rom-path'));
  const raw = new Uint8Array(readFileSync(romPath));
  const identified = identifyRom(raw, { sourcePath: romPath });
  return { record: identified.record, bytes: identified.bytes };
}

function commandImport(args: ParsedArgs, logger: Logger): number {
  const workspace = openWorkspace(args, logger);
  try {
    const { record } = loadRom(args);
    workspace.importRom(record);

    const header = record.header as Record<string, unknown>;
    process.stdout.write(
      [
        `Imported ${header['internationalTitle'] || header['domesticTitle'] || 'cartridge'}`,
        `  sha256   ${record.sha256}`,
        `  sha1     ${record.sha1}`,
        `  size     ${record.byteLength.toLocaleString()} bytes (${record.sourceFormat})`,
        `  checksum ${header['checksumMatches'] ? 'matches header' : 'DOES NOT match header'}`,
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    workspace.close();
  }
}

function commandScan(args: ParsedArgs, logger: Logger): number {
  const workspace = openWorkspace(args, logger);
  try {
    const { record, bytes } = loadRom(args);
    workspace.importRom(record);

    const records = scanRomStatically(workspace, bytes, record.sha256);
    process.stdout.write(
      `Recorded ${records.length} candidate finding(s). All are unverified candidates: ` +
        'static scanning cannot establish what the game does with these bytes.\n',
    );
    return 0;
  } finally {
    workspace.close();
  }
}

function resolveRomSha(workspace: Workspace, args: ParsedArgs): string {
  const explicit = optionalFlag(args, 'rom');
  if (explicit) return explicit;

  const roms = workspace.listRoms();
  if (roms.length === 1) return roms[0]!.sha256;
  if (roms.length === 0) throw new UsageError('This workspace has no imported ROM. Run `romlab import` first.');
  throw new UsageError(`This workspace holds ${roms.length} ROMs; pass --rom <sha256>.`);
}

function buildAdapter(args: ParsedArgs, romSha256: string): EmulatorAdapter {
  const kind = optionalFlag(args, 'adapter') ?? 'mock';

  if (kind === 'mock') return new MockGenesisAdapter({ romSha256 });

  if (kind === 'bizhawk') {
    const port = numberFlag(args, 'port');
    return new BizHawkAdapter({
      ...(optionalFlag(args, 'bizhawk') ? { executablePath: optionalFlag(args, 'bizhawk')! } : {}),
      ...(optionalFlag(args, 'external-tool') ? { externalToolPath: optionalFlag(args, 'external-tool')! } : {}),
      ...(optionalFlag(args, 'bizhawk-version') ? { expectedVersion: optionalFlag(args, 'bizhawk-version')! } : {}),
      ...(optionalFlag(args, 'core') ? { expectedCore: optionalFlag(args, 'core')! } : {}),
      ...(port !== undefined ? { port } : {}),
    });
  }

  throw new UsageError(`Unknown adapter "${kind}" (expected mock or bizhawk).`);
}

async function commandCapture(args: ParsedArgs, logger: Logger): Promise<number> {
  const workspace = openWorkspace(args, logger);

  try {
    const romPath = path.resolve(requireFlag(args, 'rom-path'));
    const romSha256 = optionalFlag(args, 'rom') ?? loadRom(args).record.sha256;

    if (!workspace.getRom(romSha256)) {
      const { record } = loadRom(args);
      workspace.importRom(record);
    }

    const sessionId = optionalFlag(args, 'session') ?? `sess-${Date.now().toString(36)}`;
    const scenario = optionalFlag(args, 'scenario');

    const session = await CaptureSession.open({
      workspace,
      adapter: buildAdapter(args, romSha256),
      romSha256,
      sessionId,
      ...(scenario !== undefined ? { scenario } : {}),
      connect: { romPath, romSha256 },
    });

    try {
      for (const step of parseScenario(optionalFlag(args, 'steps') ?? '')) {
        if (step.kind === 'advance') await session.advance(step.frames);
        else await session.press(step.buttons as GenesisButton[], step.frames);
      }

      const domains = (optionalFlag(args, 'domains') ?? 'VRAM,CRAM,68K RAM')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ domain: name as MemoryDomain, length: defaultDomainLength(name) }));

      const savestate = optionalFlag(args, 'savestate');
      const manifest = await session.capture({
        domains,
        screenshot: boolFlag(args, 'screenshot'),
        ...(scenario !== undefined ? { scenario } : {}),
        ...(savestate !== undefined ? { savestateLabel: savestate } : {}),
      });

      process.stdout.write(
        [
          `Captured ${manifest.captureId} at frame ${manifest.frame}`,
          `  session   ${sessionId}`,
          `  emulator  ${manifest.emulator.name} ${manifest.emulator.version} / ${manifest.emulator.core}`,
          `  domains   ${manifest.domains.map((d) => `${d.domain} (${d.length}B)`).join(', ')}`,
          `  artifacts ${manifest.artifacts.map((a) => a.kind).join(', ') || 'none'}`,
          '',
        ].join('\n'),
      );
      return 0;
    } finally {
      await session.close();
    }
  } finally {
    workspace.close();
  }
}

function defaultDomainLength(domain: string): number {
  switch (domain) {
    case 'VRAM':
      return 0x10000;
    case 'CRAM':
      return 128;
    case 'VSRAM':
      return 80;
    default:
      return 0x10000;
  }
}

function commandReconstruct(args: ParsedArgs, logger: Logger): number {
  const workspace = openWorkspace(args, logger);

  try {
    const captureId = requireFlag(args, 'capture');
    const manifest = workspace.getCapture(captureId);
    if (!manifest) throw new UsageError(`No capture "${captureId}" in this workspace.`);

    const satStart = numberFlag(args, 'sat-start');
    if (satStart === undefined) {
      throw new UsageError(
        '--sat-start is required. It is the sprite attribute table address from VDP register 5. ' +
          `ROMLab will not guess it. (The mock adapter's fixture uses 0x${SYNTHETIC_SAT_START.toString(16).toUpperCase()}.)`,
      );
    }

    const minObjectArea = numberFlag(args, 'min-area');
    const result = reconstructCapture(workspace, manifest, {
      satStart,
      writeImages: boolFlag(args, 'write-images'),
      ...(minObjectArea !== undefined ? { minObjectArea } : {}),
    });

    process.stdout.write(
      `Reconstructed ${result.objects.length} object(s) from ${captureId} at frame ${manifest.frame}.\n`,
    );
    for (const [index, object] of result.objects.entries()) {
      process.stdout.write(
        `  object ${index}: ${object.width}x${object.height} at (${object.x}, ${object.y}) ` +
          `from ${object.sprites.length} sprite(s), palette line(s) ${object.paletteLines.join('/')}\n`,
      );
    }
    if (result.imagePaths.length > 0) {
      process.stdout.write(`  wrote ${result.imagePaths.length} PNG(s) under private-repro/\n`);
    }
    return 0;
  } finally {
    workspace.close();
  }
}

function commandAudit(args: ParsedArgs): number {
  const workspace = Workspace.open(requireFlag(args, 'workspace'));

  try {
    const records = workspace.ledger.query();
    const issues = auditAll(records);
    const chain = workspace.ledger.verifyChain();

    process.stdout.write(`Records: ${records.length}\n`);
    process.stdout.write(`Ledger head: ${workspace.ledger.headHash()}\n`);
    process.stdout.write(`Chain intact: ${chain.ok ? 'yes' : 'NO'}\n`);

    if (!chain.ok) {
      process.stdout.write(`  broken at ${chain.brokenAt}: ${chain.reason}\n`);
    }

    process.stdout.write(`Auditor issues: ${issues.length}\n`);
    for (const issue of issues) {
      process.stdout.write(`  [${issue.rule}] ${issue.recordId}: ${issue.message}\n`);
    }

    return issues.length === 0 && chain.ok ? 0 : 1;
  } finally {
    workspace.close();
  }
}

function commandReport(args: ParsedArgs): number {
  const workspace = Workspace.open(requireFlag(args, 'workspace'));

  try {
    const markdown = renderReport(workspace, resolveRomSha(workspace, args));
    const out = optionalFlag(args, 'out');

    if (out) {
      mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      writeFileSync(out, markdown);
      process.stdout.write(`Wrote ${out}\n`);
    } else {
      process.stdout.write(markdown);
    }
    return 0;
  } finally {
    workspace.close();
  }
}

function commandExport(args: ParsedArgs): number {
  const workspace = Workspace.open(requireFlag(args, 'workspace'));

  try {
    const mode = (optionalFlag(args, 'mode') ?? 'public') as 'public' | 'private_research';
    if (mode !== 'public' && mode !== 'private_research') {
      throw new UsageError(`--mode must be public or private_research, received "${mode}"`);
    }

    const romSha256 = resolveRomSha(workspace, args);
    const out = optionalFlag(args, 'out') ?? workspace.exportPath(`${mode}-${romSha256.slice(0, 12)}.json`);

    const pkg = buildExportPackage(workspace, {
      mode,
      romSha256,
      ...(mode === 'private_research' ? { destination: out } : {}),
    });

    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, `${canonicalJson(pkg)}\n`);

    process.stdout.write(
      [
        `Wrote ${mode} export to ${out}`,
        `  evidence  ${pkg.evidence.length} record(s)`,
        `  captures  ${pkg.captures.length}`,
        `  ledger    ${pkg.audit.ledgerIntact ? 'intact' : 'BROKEN'}`,
        mode === 'public'
          ? '  contents  claims and provenance only; no ROM, savestates, dumps or reconstructions'
          : '  contents  full research detail — keep under private-repro',
        '',
      ].join('\n'),
    );

    return pkg.audit.ledgerIntact ? 0 : 1;
  } finally {
    workspace.close();
  }
}

export { USAGE };
