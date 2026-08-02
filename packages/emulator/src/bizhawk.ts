import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { BridgeResponse, EmulatorStatus, FrameCommand } from '@romlab/schema';

import { EmulatorError, RomIdentityMismatch, expectOk, type ConnectOptions, type EmulatorAdapter } from './adapter.js';
import { BridgeClient } from './bridge.js';

/**
 * BizHawk adapter.
 *
 * Control goes through the ROMLab external tool (`bridge/ROMLab.BizHawk`), which
 * talks ApiHawk inside the emulator process and exposes the bridge protocol on a
 * TCP port. Notably it does *not* drive BizHawk by synthesising keystrokes:
 * simulated input is not reproducible, and reproducibility is the product.
 */

export interface BizHawkOptions {
  /** Path to EmuHawk.exe. Omit to attach to an already-running instance. */
  executablePath?: string;
  /** Path to the built ROMLab external tool DLL. */
  externalToolPath?: string;
  host?: string;
  port?: number;
  /**
   * BizHawk version this workspace is pinned to. A capture from a different
   * build is not comparable, so a mismatch is refused rather than warned about.
   */
  expectedVersion?: string;
  expectedCore?: string;
  /** Extra EmuHawk arguments, e.g. a config path. */
  extraArgs?: string[];
}

export const DEFAULT_BRIDGE_PORT = 51_735;

export class BizHawkAdapter implements EmulatorAdapter {
  readonly id = 'bizhawk';

  private client?: BridgeClient;
  private process?: ChildProcess;

  constructor(private readonly options: BizHawkOptions = {}) {}

  async connect(options: ConnectOptions): Promise<EmulatorStatus> {
    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? DEFAULT_BRIDGE_PORT;
    const timeoutMs = options.timeoutMs ?? 60_000;

    if (this.options.executablePath) {
      this.launch(options.romPath, port);
    }

    const client = new BridgeClient(host, port, timeoutMs);
    await this.connectWithRetry(client, timeoutMs);
    this.client = client;

    const response = expectOk(await client.send({ op: 'status' }));
    if (response.result?.kind !== 'status') {
      throw new EmulatorError('Bridge did not report emulator status.', 'bridge_protocol_error');
    }

    const status = response.result.status;

    if (status.romSha256 !== options.romSha256) {
      await this.disconnect();

      // An empty hash is a distinct failure from a wrong one: the bridge could
      // not determine what is loaded at all. ApiHawk cannot report the loaded
      // ROM's path, so ROMLab supplies it through ROMLAB_ROM_PATH when it
      // launches EmuHawk. Attaching to an emulator someone else started skips
      // that step, which is the usual cause.
      if (status.romSha256 === '') {
        throw new EmulatorError(
          'The ROMLab bridge could not determine which ROM is loaded' +
            (status.gameName ? ` (BizHawk reports "${status.gameName}")` : '') +
            '. Launch EmuHawk through ROMLab (pass --bizhawk), or set ROMLAB_ROM_PATH ' +
            'in its environment before opening the tool. ROMLab will not attribute ' +
            'captures to an unverified cartridge.',
          'rom_identity_unknown',
        );
      }

      throw new RomIdentityMismatch(options.romSha256, status.romSha256);
    }

    if (this.options.expectedVersion && status.emulatorVersion !== this.options.expectedVersion) {
      await this.disconnect();
      throw new EmulatorError(
        `Workspace is pinned to BizHawk ${this.options.expectedVersion} but ${status.emulatorVersion} is running. ` +
          'Captures across emulator versions are not comparable.',
        'emulator_version_mismatch',
      );
    }

    if (this.options.expectedCore && status.core !== this.options.expectedCore) {
      await this.disconnect();
      throw new EmulatorError(
        `Workspace is pinned to core "${this.options.expectedCore}" but "${status.core}" is loaded.`,
        'core_mismatch',
      );
    }

    return status;
  }

  async send(command: FrameCommand): Promise<BridgeResponse> {
    if (!this.client) throw new EmulatorError('BizHawk adapter is not connected.', 'not_connected');
    return this.client.send(command);
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = undefined as BridgeClient | undefined;

    if (this.process && this.process.exitCode === null) {
      this.process.kill();
    }
    this.process = undefined as ChildProcess | undefined;
  }

  private launch(romPath: string, port: number): void {
    const executablePath = this.options.executablePath!;
    if (!existsSync(executablePath)) {
      throw new EmulatorError(`EmuHawk not found at ${executablePath}`, 'emuhawk_not_found');
    }
    if (this.options.externalToolPath && !existsSync(this.options.externalToolPath)) {
      throw new EmulatorError(
        `ROMLab external tool not found at ${this.options.externalToolPath}. Build bridge/ROMLab.BizHawk first.`,
        'external_tool_not_found',
      );
    }
    if (!existsSync(romPath)) {
      throw new EmulatorError(`ROM not found at ${romPath}`, 'rom_not_found');
    }

    const args = [romPath, ...(this.options.extraArgs ?? [])];
    if (this.options.externalToolPath) {
      args.push(`--open-ext-tool-dll=${this.options.externalToolPath}`);
    }

    this.process = spawn(executablePath, args, {
      stdio: 'ignore',
      detached: false,
      env: {
        ...process.env,
        ROMLAB_BRIDGE_PORT: String(port),
        // ApiHawk cannot report the loaded ROM's path, so the bridge hashes
        // this file to establish identity. Without it the bridge reports an
        // empty hash and `connect` refuses.
        ROMLAB_ROM_PATH: romPath,
      },
    });

    this.process.on('error', (error) => {
      throw new EmulatorError(`Failed to launch EmuHawk: ${error.message}`, 'emuhawk_launch_failed');
    });
  }

  /** EmuHawk takes several seconds to boot and load the tool; poll until it answers. */
  private async connectWithRetry(client: BridgeClient, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        await client.connect(Math.max(1_000, deadline - Date.now()));
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new EmulatorError('Could not reach the ROMLab bridge.', 'bridge_connect_failed');
  }
}
