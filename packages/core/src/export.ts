import path from 'node:path';

import {
  PRIVATE_EXPORT_DIRECTORY,
  ROMLAB_VERSION,
  auditAll,
  type AuditIssue,
  type CaptureManifest,
  type EvidenceRecord,
  type ExportMode,
  type RomRecord,
} from '@romlab/schema';

import type { Workspace } from './workspace.js';

export class ExportBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportBoundaryError';
  }
}

/**
 * ROM-derived media may only be written beneath a directory literally named
 * `private-repro`. This makes the boundary visible in the filesystem, so an
 * operator zipping up a project folder can see what they are about to share.
 */
export function assertPrivateDestination(destination: string): void {
  const segments = path.resolve(destination).split(path.sep);
  if (!segments.includes(PRIVATE_EXPORT_DIRECTORY)) {
    throw new ExportBoundaryError(
      `Refusing to write ROM-derived output to ${destination}: the path must lie under a "${PRIVATE_EXPORT_DIRECTORY}" directory.`,
    );
  }
}

/** Capture metadata that is safe to publish: identity and hashes, no content. */
export interface PublicCaptureSummary {
  captureId: string;
  sessionId: string;
  frame: number;
  scenario?: string;
  emulator: CaptureManifest['emulator'];
  input?: CaptureManifest['input'];
  domains: { domain: string; start: number; length: number; sha256: string }[];
  artifacts: { kind: string; sha256: string }[];
  createdAt: string;
}

export interface ExportPackage {
  schema: 'romlab.export.v1';
  mode: ExportMode;
  romlabVersion: string;
  workspace: { id: string; name: string; createdAt: string };
  rom: Omit<RomRecord, 'sourcePath'> & { sourcePath?: string };
  captures: (PublicCaptureSummary | CaptureManifest)[];
  evidence: EvidenceRecord[];
  audit: { issues: AuditIssue[]; ledgerHead: string; ledgerIntact: boolean };
  generatedAt: string;
}

export interface ExportOptions {
  mode: ExportMode;
  romSha256: string;
  /** Required when mode is `private_research`; must sit under `private-repro`. */
  destination?: string;
  now?: () => string;
}

/**
 * Builds an export package.
 *
 * A `public` package carries claims and provenance but no cartridge-derived
 * bytes: no ROM, no savestates, no memory dumps, no screenshots, no
 * reconstructions, and not even the operator's local ROM path.
 */
export function buildExportPackage(workspace: Workspace, options: ExportOptions): ExportPackage {
  const now = options.now ?? (() => new Date().toISOString());

  const rom = workspace.getRom(options.romSha256);
  if (!rom) {
    throw new ExportBoundaryError(`ROM ${options.romSha256} is not present in this workspace.`);
  }

  if (options.mode === 'private_research') {
    if (!options.destination) {
      throw new ExportBoundaryError('A private_research export requires an explicit destination.');
    }
    assertPrivateDestination(options.destination);
  }

  const evidence = workspace.ledger.query({ romSha256: options.romSha256 });
  const captures = workspace.listCaptures({ romSha256: options.romSha256 });
  const chain = workspace.ledger.verifyChain();

  const isPrivate = options.mode === 'private_research';

  return {
    schema: 'romlab.export.v1',
    mode: options.mode,
    romlabVersion: ROMLAB_VERSION,
    workspace: {
      id: workspace.manifest.id,
      name: workspace.manifest.name,
      createdAt: workspace.manifest.createdAt,
    },
    rom: isPrivate ? rom : stripRomPath(rom),
    captures: isPrivate ? captures : captures.map(summariseCapture),
    evidence: isPrivate ? evidence : evidence.map(stripPrivateLocators),
    audit: {
      issues: auditAll(evidence),
      ledgerHead: workspace.ledger.headHash(),
      ledgerIntact: chain.ok,
    },
    generatedAt: now(),
  };
}

function stripRomPath(rom: RomRecord): Omit<RomRecord, 'sourcePath'> {
  const { sourcePath: _ignored, ...rest } = rom;
  return rest;
}

function summariseCapture(capture: CaptureManifest): PublicCaptureSummary {
  const summary: PublicCaptureSummary = {
    captureId: capture.captureId,
    sessionId: capture.sessionId,
    frame: capture.frame,
    emulator: capture.emulator,
    // Paths are dropped; hashes stay so a holder of the private package can
    // prove the public claims refer to the same bytes.
    domains: capture.domains.map((d) => ({
      domain: d.domain,
      start: d.start,
      length: d.length,
      sha256: d.sha256,
    })),
    artifacts: capture.artifacts.map((a) => ({ kind: a.kind, sha256: a.sha256 })),
    createdAt: capture.createdAt,
  };
  if (capture.scenario !== undefined) summary.scenario = capture.scenario;
  if (capture.input !== undefined) summary.input = capture.input;
  return summary;
}

function stripPrivateLocators(record: EvidenceRecord): EvidenceRecord {
  const { artifactPath: _dropped, ...locator } = record.locator;
  return { ...record, locator };
}

/** Every artifact path a public package must not contain. */
export function findLeakedPaths(pkg: ExportPackage): string[] {
  if (pkg.mode === 'private_research') return [];

  const leaked: string[] = [];
  const serialised = JSON.stringify(pkg);

  for (const marker of [PRIVATE_EXPORT_DIRECTORY, '.bin', '.smd', '.gen', '.state', '.wav', '.png']) {
    if (serialised.includes(marker)) leaked.push(marker);
  }

  return leaked;
}
