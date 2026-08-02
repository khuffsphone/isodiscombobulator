import type { GenesisButton, MemoryDomain } from './capture.js';

/**
 * The canonical frame-command vocabulary.
 *
 * Every emulator adapter — BizHawk, the deterministic mock, anything added
 * later — speaks exactly this. Commands are the only way to move the machine,
 * which is what makes a session reproducible: the command log plus the ROM hash
 * plus the emulator identity fully determine the observation stream.
 */
export type FrameCommand =
  | { op: 'reset' }
  | { op: 'advance'; frames: number }
  | { op: 'setInput'; port: number; buttons: readonly GenesisButton[] }
  | { op: 'saveState'; label: string }
  | { op: 'loadState'; label: string }
  | { op: 'readDomain'; domain: MemoryDomain; start: number; length: number }
  | { op: 'screenshot' }
  | { op: 'captureAudio'; frames: number }
  | { op: 'status' };

export type FrameCommandOp = FrameCommand['op'];

/**
 * Bridge wire format: newline-delimited JSON, one request and one response per
 * line, correlated by `id`. Chosen over a binary protocol because a human
 * debugging a desync can read the transcript directly.
 */
export interface BridgeRequest {
  id: number;
  command: FrameCommand;
}

export interface BridgeResponseOk {
  id: number;
  ok: true;
  /** Emulator frame counter after the command completed. */
  frame: number;
  result?: BridgeResult;
}

export interface BridgeResponseError {
  id: number;
  ok: false;
  frame?: number;
  error: { code: string; message: string };
}

export type BridgeResponse = BridgeResponseOk | BridgeResponseError;

export type BridgeResult =
  | { kind: 'status'; status: EmulatorStatus }
  | { kind: 'domain'; domain: MemoryDomain; start: number; base64: string }
  | { kind: 'screenshot'; width: number; height: number; base64: string }
  | { kind: 'audio'; sampleRate: number; channels: number; base64: string }
  | { kind: 'savestate'; label: string; sha256: string; base64?: string }
  | { kind: 'none' };

export interface EmulatorStatus {
  emulator: string;
  emulatorVersion: string;
  core: string;
  coreVersion?: string;
  romSha256: string;
  frame: number;
  paused: boolean;
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['id'] === 'number' && typeof candidate['ok'] === 'boolean';
}

/**
 * A command log entry — what was asked, and the frame it landed on. Persisted
 * with every session so a capture can be replayed command-for-command.
 */
export interface CommandLogEntry {
  sequence: number;
  command: FrameCommand;
  frameBefore: number;
  frameAfter: number;
  at: string;
}
