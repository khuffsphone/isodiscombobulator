import { ISO_INSTANT_PATTERN, SHA1_PATTERN, SHA256_PATTERN, Validator, type ValidationResult } from './validate.js';

export const WORKSPACE_SCHEMA_ID = 'romlab.workspace.v1' as const;

/** Bumped whenever a migration is added in `@romlab/core`. */
export const WORKSPACE_SCHEMA_VERSION = 1;

export const PLATFORMS = ['genesis', 'snes', 'nes', 'gameboy', 'gba', 'arcade', 'playstation'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * ROM identity and provenance.
 *
 * `path` is the operator's local file. ROMLab records where a ROM came from
 * and never copies its contents into the workspace database or any export.
 */
export interface RomRecord {
  sha256: string;
  sha1: string;
  platform: Platform;
  /** Size of the normalised image, after de-interleaving if applicable. */
  byteLength: number;
  /** Original container format, e.g. "bin" or "smd". */
  sourceFormat: string;
  /** Absolute path on the operator's machine at import time. */
  sourcePath: string;
  importedAt: string;
  /** Platform-specific header fields, e.g. Genesis serial/region/checksum. */
  header: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  romSha256: string;
  adapter: string;
  emulator: { name: string; version: string; core: string; coreVersion?: string };
  startedAt: string;
  endedAt?: string;
  scenario?: string;
}

export interface WorkspaceManifest {
  schema: typeof WORKSPACE_SCHEMA_ID;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  /** Version of the tool that created the workspace. */
  romlabVersion: string;
}

export function validateWorkspaceManifest(value: unknown): ValidationResult {
  const v = new Validator('workspace');
  if (!v.object(value, '')) return v.result();

  if (value['schema'] !== WORKSPACE_SCHEMA_ID) {
    v.fail('schema', `expected "${WORKSPACE_SCHEMA_ID}"`);
  }
  v.integer(value['schemaVersion'], 'schemaVersion', { min: 1 });
  v.string(value['id'], 'id', { min: 1 });
  v.string(value['name'], 'name', { min: 1 });
  v.string(value['romlabVersion'], 'romlabVersion', { min: 1 });
  v.string(value['createdAt'], 'createdAt', { pattern: ISO_INSTANT_PATTERN });

  return v.result();
}

export function validateRomRecord(value: unknown): ValidationResult {
  const v = new Validator('rom');
  if (!v.object(value, '')) return v.result();

  v.string(value['sha256'], 'sha256', { pattern: SHA256_PATTERN });
  v.string(value['sha1'], 'sha1', { pattern: SHA1_PATTERN });
  v.oneOf(value['platform'], 'platform', PLATFORMS);
  v.integer(value['byteLength'], 'byteLength', { min: 1 });
  v.string(value['sourceFormat'], 'sourceFormat', { min: 1 });
  v.string(value['sourcePath'], 'sourcePath', { min: 1 });
  v.string(value['importedAt'], 'importedAt', { pattern: ISO_INSTANT_PATTERN });
  v.object(value['header'], 'header');

  return v.result();
}

/**
 * What may leave the machine.
 *
 * `public` is the default and is the only mode that produces a shareable
 * package: reports, metrics, annotations and provenance, with no ROM-derived
 * imagery, audio, savestates or raw memory. `private_research` additionally
 * includes reconstructions and dumps and is written only under a directory
 * named `private-repro`.
 */
export const EXPORT_MODES = ['public', 'private_research'] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

/** Artifact classes that must never appear in a `public` export. */
export const PRIVATE_ONLY_ARTIFACTS = [
  'savestate',
  'domain_dump',
  'audio',
  'screenshot',
  'reconstruction',
  'rom',
] as const;

export const PRIVATE_EXPORT_DIRECTORY = 'private-repro';
