import {
  ISO_INSTANT_PATTERN,
  SHA256_PATTERN,
  Validator,
  type ValidationResult,
} from './validate.js';

export const CAPTURE_SCHEMA_ID = 'romlab.capture.v1' as const;

/**
 * Memory domains ROMLab understands. Names match BizHawk's Genesis domain
 * names so the bridge does not have to translate.
 */
export const MEMORY_DOMAINS = [
  '68K RAM',
  'Z80 RAM',
  'VRAM',
  'CRAM',
  'VSRAM',
  'SRAM',
  'MD CART',
] as const;

export type MemoryDomain = (typeof MEMORY_DOMAINS)[number];

export const ARTIFACT_KINDS = ['screenshot', 'audio', 'savestate', 'movie', 'domain_dump'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Genesis controller buttons in the order the bridge serialises them.
 * A frame's input is the set of buttons held on that frame.
 */
export const GENESIS_BUTTONS = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'C', 'Start', 'X', 'Y', 'Z', 'Mode'] as const;
export type GenesisButton = (typeof GENESIS_BUTTONS)[number];

export interface EmulatorIdentity {
  /** e.g. "BizHawk" */
  name: string;
  /** e.g. "2.9.1" — pinned; captures from an unpinned build are rejected upstream. */
  version: string;
  /** e.g. "Genplus-gx" */
  core: string;
  coreVersion?: string;
  /** Hash of the core settings/sync-settings blob, so config drift is detectable. */
  coreConfigHash?: string;
}

export interface CapturedDomain {
  domain: MemoryDomain;
  /** Byte offset within the domain where this dump starts. */
  start: number;
  length: number;
  sha256: string;
  /** Workspace-relative path to the raw dump, if it was retained. */
  path?: string;
}

export interface CapturedArtifact {
  kind: ArtifactKind;
  path: string;
  sha256: string;
  /** Present for screenshots. */
  width?: number;
  height?: number;
  /** Present for audio. */
  sampleRate?: number;
  channels?: number;
}

export interface FrameInput {
  /** Buttons held by each controller port on this frame. */
  ports: string[][];
}

/**
 * One synchronised observation of the running machine at one exact frame.
 * This is the atomic unit of runtime evidence.
 */
export interface CaptureManifest {
  schema: typeof CAPTURE_SCHEMA_ID;
  captureId: string;
  sessionId: string;
  /** Identity of the ROM that produced this capture. Non-negotiable. */
  romSha256: string;
  emulator: EmulatorIdentity;
  /** Emulator frame counter at the moment of capture. */
  frame: number;
  /** Input held on this frame, when the bridge reported it. */
  input?: FrameInput;
  /** Savestate this capture was reached from, when one was used. */
  savestateSha256?: string;
  domains: CapturedDomain[];
  artifacts: CapturedArtifact[];
  /** Free-form scenario label, e.g. "standing-jab". */
  scenario?: string;
  createdAt: string;
  notes?: string;
}

export function validateCaptureManifest(value: unknown): ValidationResult {
  const v = new Validator('capture');
  if (!v.object(value, '')) return v.result();

  if (value['schema'] !== CAPTURE_SCHEMA_ID) {
    v.fail('schema', `expected "${CAPTURE_SCHEMA_ID}"`);
  }
  v.string(value['captureId'], 'captureId', { min: 1 });
  v.string(value['sessionId'], 'sessionId', { min: 1 });
  v.string(value['romSha256'], 'romSha256', { pattern: SHA256_PATTERN });
  v.integer(value['frame'], 'frame', { min: 0 });
  v.string(value['createdAt'], 'createdAt', { pattern: ISO_INSTANT_PATTERN });

  if (v.object(value['emulator'], 'emulator')) {
    const emu = value['emulator'];
    v.string(emu['name'], 'emulator.name', { min: 1 });
    v.string(emu['version'], 'emulator.version', { min: 1 });
    v.string(emu['core'], 'emulator.core', { min: 1 });
  }

  if (value['savestateSha256'] !== undefined) {
    v.string(value['savestateSha256'], 'savestateSha256', { pattern: SHA256_PATTERN });
  }

  if (value['input'] !== undefined && v.object(value['input'], 'input')) {
    if (v.array(value['input']['ports'], 'input.ports')) {
      value['input']['ports'].forEach((port, i) => {
        v.array(port, `input.ports[${i}]`);
      });
    }
  }

  if (v.array(value['domains'], 'domains')) {
    value['domains'].forEach((entry, i) => {
      if (!v.object(entry, `domains[${i}]`)) return;
      v.oneOf(entry['domain'], `domains[${i}].domain`, MEMORY_DOMAINS);
      v.integer(entry['start'], `domains[${i}].start`, { min: 0 });
      v.integer(entry['length'], `domains[${i}].length`, { min: 1 });
      v.string(entry['sha256'], `domains[${i}].sha256`, { pattern: SHA256_PATTERN });
    });
  }

  if (v.array(value['artifacts'], 'artifacts')) {
    value['artifacts'].forEach((entry, i) => {
      if (!v.object(entry, `artifacts[${i}]`)) return;
      v.oneOf(entry['kind'], `artifacts[${i}].kind`, ARTIFACT_KINDS);
      v.string(entry['path'], `artifacts[${i}].path`, { min: 1 });
      v.string(entry['sha256'], `artifacts[${i}].sha256`, { pattern: SHA256_PATTERN });
    });
  }

  return v.result();
}

/** Convenience lookup used by the reconstruction pipeline. */
export function findDomain(
  manifest: CaptureManifest,
  domain: MemoryDomain,
): CapturedDomain | undefined {
  return manifest.domains.find((d) => d.domain === domain);
}
