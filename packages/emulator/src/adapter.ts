import type { BridgeResponse, EmulatorStatus, FrameCommand } from '@romlab/schema';

/**
 * The emulator plugin contract.
 *
 * Every adapter — the BizHawk bridge, the deterministic mock, anything added
 * later — implements exactly this. Keeping the surface this narrow is what
 * makes sessions portable: a scenario recorded against one adapter is a list of
 * `FrameCommand`s, and any adapter that honours them reproduces the run.
 */
export interface EmulatorAdapter {
  /** Stable identifier recorded on every session, e.g. "bizhawk" or "mock". */
  readonly id: string;

  connect(options: ConnectOptions): Promise<EmulatorStatus>;
  send(command: FrameCommand): Promise<BridgeResponse>;
  disconnect(): Promise<void>;
}

export interface ConnectOptions {
  /** Absolute path to the operator's ROM. Never copied by ROMLab. */
  romPath: string;
  /** Expected identity; the adapter must refuse a mismatch. */
  romSha256: string;
  /** Milliseconds to wait for the emulator to become responsive. */
  timeoutMs?: number;
}

export class EmulatorError extends Error {
  constructor(
    message: string,
    readonly code: string = 'emulator_error',
  ) {
    super(message);
    this.name = 'EmulatorError';
  }
}

export class RomIdentityMismatch extends EmulatorError {
  constructor(expected: string, actual: string) {
    super(
      `Emulator loaded ROM ${actual} but the workspace expects ${expected}. ` +
        'Refusing to attribute captures to the wrong cartridge.',
      'rom_identity_mismatch',
    );
    this.name = 'RomIdentityMismatch';
  }
}

/** Unwraps a bridge response, throwing on the error variant. */
export function expectOk(response: BridgeResponse): Extract<BridgeResponse, { ok: true }> {
  if (!response.ok) {
    throw new EmulatorError(`${response.error.code}: ${response.error.message}`, response.error.code);
  }
  return response;
}
