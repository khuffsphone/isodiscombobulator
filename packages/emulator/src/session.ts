import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sha256, type Workspace } from '@romlab/core';
import {
  CAPTURE_SCHEMA_ID,
  type CaptureManifest,
  type CapturedArtifact,
  type CapturedDomain,
  type CommandLogEntry,
  type EmulatorStatus,
  type FrameCommand,
  type GenesisButton,
  type MemoryDomain,
} from '@romlab/schema';

import { EmulatorError, expectOk, type EmulatorAdapter, type ConnectOptions } from './adapter.js';

export interface CaptureRequest {
  scenario?: string;
  /** Memory domains to dump, in full or in part. */
  domains?: { domain: MemoryDomain; start?: number; length: number }[];
  screenshot?: boolean;
  /** Frames of audio to capture alongside the frame. */
  audioFrames?: number;
  savestateLabel?: string;
  notes?: string;
}

export interface SessionOptions {
  workspace: Workspace;
  adapter: EmulatorAdapter;
  romSha256: string;
  sessionId: string;
  scenario?: string;
  /** Injected for deterministic tests. */
  now?: () => string;
}

/**
 * Drives an emulator adapter and turns what it reports into workspace evidence.
 *
 * Every command is logged with the frame it landed on, and every capture is
 * pinned to the ROM hash, the emulator identity and an exact frame. That triple
 * is what makes a finding reproducible months later, and it is recorded here
 * rather than left to whoever writes the analysis.
 */
export class CaptureSession {
  private commandSequence = 0;
  private captureSequence = 0;
  private readonly commandLog: CommandLogEntry[] = [];
  private frame = 0;
  private status?: EmulatorStatus;
  private readonly heldByPort: GenesisButton[][] = [[], []];

  private constructor(private readonly options: SessionOptions) {}

  static async open(options: SessionOptions & { connect: ConnectOptions }): Promise<CaptureSession> {
    const session = new CaptureSession(options);
    const status = await options.adapter.connect(options.connect);

    if (status.romSha256 !== options.romSha256) {
      throw new EmulatorError(
        `Adapter reports ROM ${status.romSha256}; session expects ${options.romSha256}.`,
        'rom_identity_mismatch',
      );
    }

    session.status = status;
    session.frame = status.frame;

    options.workspace.startSession({
      id: options.sessionId,
      romSha256: options.romSha256,
      adapter: options.adapter.id,
      emulator: {
        name: status.emulator,
        version: status.emulatorVersion,
        core: status.core,
        ...(status.coreVersion !== undefined ? { coreVersion: status.coreVersion } : {}),
      },
      ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
    });

    return session;
  }

  get currentFrame(): number {
    return this.frame;
  }

  get emulatorStatus(): EmulatorStatus | undefined {
    return this.status;
  }

  /** Sends one command and records it in the reproducible command log. */
  async run(command: FrameCommand): Promise<Extract<Awaited<ReturnType<EmulatorAdapter['send']>>, { ok: true }>> {
    const frameBefore = this.frame;
    const response = expectOk(await this.options.adapter.send(command));
    this.frame = response.frame;

    this.commandLog.push({
      sequence: this.commandSequence++,
      command,
      frameBefore,
      frameAfter: response.frame,
      at: this.now(),
    });

    return response;
  }

  async advance(frames = 1): Promise<void> {
    await this.run({ op: 'advance', frames });
  }

  async setInput(port: number, buttons: readonly GenesisButton[]): Promise<void> {
    this.heldByPort[port] = [...buttons];
    await this.run({ op: 'setInput', port, buttons });
  }

  /** Holds `buttons` for `frames` frames, then releases them. */
  async press(buttons: readonly GenesisButton[], frames = 1, port = 0): Promise<void> {
    await this.setInput(port, buttons);
    await this.advance(frames);
    await this.setInput(port, []);
  }

  async saveState(label: string): Promise<string> {
    const response = await this.run({ op: 'saveState', label });
    return response.result?.kind === 'savestate' ? response.result.sha256 : '';
  }

  async loadState(label: string): Promise<void> {
    await this.run({ op: 'loadState', label });
  }

  async readDomain(domain: MemoryDomain, start: number, length: number): Promise<Uint8Array> {
    const response = await this.run({ op: 'readDomain', domain, start, length });
    if (response.result?.kind !== 'domain') {
      throw new EmulatorError(`Adapter returned no data for ${domain}`, 'empty_domain_read');
    }
    return new Uint8Array(Buffer.from(response.result.base64, 'base64'));
  }

  /**
   * Takes a synchronised capture at the current frame and ingests it.
   *
   * Raw dumps land under `captures/<captureId>/` inside the workspace, which is
   * private by construction — a public export carries only their hashes.
   */
  async capture(request: CaptureRequest = {}): Promise<CaptureManifest> {
    const status = this.status;
    if (!status) throw new EmulatorError('Session is not connected.', 'not_connected');

    const captureId = `cap-${String(++this.captureSequence).padStart(4, '0')}`;
    const directory = this.options.workspace.capturePath(captureId);
    mkdirSync(directory, { recursive: true });

    const domains: CapturedDomain[] = [];
    for (const requested of request.domains ?? []) {
      const start = requested.start ?? 0;
      const bytes = await this.readDomain(requested.domain, start, requested.length);
      const fileName = `${requested.domain.replace(/\s+/g, '-').toLowerCase()}-${start}.bin`;
      writeFileSync(path.join(directory, fileName), bytes);
      domains.push({
        domain: requested.domain,
        start,
        length: bytes.length,
        sha256: sha256(bytes),
        path: path.posix.join('captures', captureId, fileName),
      });
    }

    const artifacts: CapturedArtifact[] = [];

    if (request.screenshot) {
      const response = await this.run({ op: 'screenshot' });
      if (response.result?.kind === 'screenshot') {
        const bytes = new Uint8Array(Buffer.from(response.result.base64, 'base64'));
        writeFileSync(path.join(directory, 'frame.png'), bytes);
        artifacts.push({
          kind: 'screenshot',
          path: path.posix.join('captures', captureId, 'frame.png'),
          sha256: sha256(bytes),
          width: response.result.width,
          height: response.result.height,
        });
      }
    }

    if (request.audioFrames && request.audioFrames > 0) {
      const response = await this.run({ op: 'captureAudio', frames: request.audioFrames });
      if (response.result?.kind === 'audio') {
        const bytes = new Uint8Array(Buffer.from(response.result.base64, 'base64'));
        writeFileSync(path.join(directory, 'audio.pcm'), bytes);
        artifacts.push({
          kind: 'audio',
          path: path.posix.join('captures', captureId, 'audio.pcm'),
          sha256: sha256(bytes),
          sampleRate: response.result.sampleRate,
          channels: response.result.channels,
        });
      }
    }

    let savestateSha256: string | undefined;
    if (request.savestateLabel) {
      savestateSha256 = await this.saveState(request.savestateLabel);
    }

    const manifest: CaptureManifest = {
      schema: CAPTURE_SCHEMA_ID,
      captureId,
      sessionId: this.options.sessionId,
      romSha256: this.options.romSha256,
      emulator: {
        name: status.emulator,
        version: status.emulatorVersion,
        core: status.core,
        ...(status.coreVersion !== undefined ? { coreVersion: status.coreVersion } : {}),
      },
      frame: this.frame,
      input: { ports: this.heldByPort.map((buttons) => [...buttons]) },
      domains,
      artifacts,
      createdAt: this.now(),
      ...(savestateSha256 ? { savestateSha256 } : {}),
      ...(request.scenario ?? this.options.scenario
        ? { scenario: request.scenario ?? this.options.scenario! }
        : {}),
      ...(request.notes !== undefined ? { notes: request.notes } : {}),
    };

    return this.options.workspace.ingestCapture(manifest);
  }

  /** Flushes the command log and closes the adapter. */
  async close(): Promise<void> {
    this.options.workspace.logCommands(this.options.sessionId, this.commandLog);
    this.options.workspace.endSession(this.options.sessionId, this.now());
    await this.options.adapter.disconnect();
  }

  get log(): readonly CommandLogEntry[] {
    return this.commandLog;
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }
}
