import { sha256 } from '@romlab/core';
import {
  buildSyntheticVdpState,
  encodePng,
  reconstructObjects,
  createImage,
  SYNTHETIC_SAT_START,
  type SyntheticVdpState,
} from '@romlab/platform-genesis';
import type { BridgeResponse, EmulatorStatus, FrameCommand, MemoryDomain } from '@romlab/schema';

import { RomIdentityMismatch, type ConnectOptions, type EmulatorAdapter } from './adapter.js';

/**
 * A deterministic stand-in for a running Genesis.
 *
 * This is not an emulator and does not pretend to be one. It is a fixture that
 * honours the same command vocabulary as the BizHawk bridge and mutates a small
 * amount of state in response to input, so the capture pipeline, the
 * reconstruction pipeline, differential RAM search and the evidence rules can
 * all be exercised end to end on a Linux CI box with no ROM and no emulator.
 *
 * Determinism is the point: the same command sequence always produces the same
 * bytes, so a test can assert on exact hashes.
 */

export const MOCK_STAMINA_ADDRESS = 0x1234;
export const MOCK_PLAYER_X_ADDRESS = 0x1240;

const RAM_SIZE = 0x10000;

interface MockState {
  frame: number;
  ram: Uint8Array;
  heldByPort: string[][];
}

export interface MockAdapterOptions {
  /** Identity this mock claims to have loaded. */
  romSha256: string;
  emulatorVersion?: string;
  core?: string;
}

export class MockGenesisAdapter implements EmulatorAdapter {
  readonly id = 'mock';

  private readonly vdp: SyntheticVdpState = buildSyntheticVdpState();
  private readonly savestates = new Map<string, string>();
  private state: MockState = freshState();
  private connected = false;

  constructor(private readonly options: MockAdapterOptions) {}

  async connect(options: ConnectOptions): Promise<EmulatorStatus> {
    if (options.romSha256 !== this.options.romSha256) {
      throw new RomIdentityMismatch(options.romSha256, this.options.romSha256);
    }
    this.state = freshState();
    this.connected = true;
    return this.status();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(command: FrameCommand): Promise<BridgeResponse> {
    if (!this.connected) {
      return {
        id: 0,
        ok: false,
        error: { code: 'not_connected', message: 'Adapter is not connected.' },
      };
    }

    switch (command.op) {
      case 'status':
        return this.ok({ kind: 'status', status: this.status() });

      case 'reset':
        this.state = freshState();
        return this.ok({ kind: 'none' });

      case 'advance':
        for (let i = 0; i < command.frames; i += 1) this.tick();
        return this.ok({ kind: 'none' });

      case 'setInput': {
        while (this.state.heldByPort.length <= command.port) this.state.heldByPort.push([]);
        this.state.heldByPort[command.port] = [...command.buttons];
        return this.ok({ kind: 'none' });
      }

      case 'readDomain': {
        const bytes = this.readDomain(command.domain, command.start, command.length);
        if (!bytes) {
          return {
            id: 0,
            ok: false,
            frame: this.state.frame,
            error: { code: 'unknown_domain', message: `No such domain: ${command.domain}` },
          };
        }
        return this.ok({
          kind: 'domain',
          domain: command.domain,
          start: command.start,
          base64: Buffer.from(bytes).toString('base64'),
        });
      }

      case 'screenshot': {
        const png = this.renderFrame();
        return this.ok({
          kind: 'screenshot',
          width: 320,
          height: 224,
          base64: Buffer.from(png).toString('base64'),
        });
      }

      case 'captureAudio': {
        // A silent, correctly-shaped buffer. The mock has no sound driver, and
        // inventing waveform data would be exactly the kind of fabricated
        // evidence this product exists to prevent.
        const samples = new Uint8Array(command.frames * 735 * 2 * 2);
        return this.ok({
          kind: 'audio',
          sampleRate: 44100,
          channels: 2,
          base64: Buffer.from(samples).toString('base64'),
        });
      }

      case 'saveState': {
        const blob = JSON.stringify({
          frame: this.state.frame,
          ram: Buffer.from(this.state.ram).toString('base64'),
          heldByPort: this.state.heldByPort,
        });
        this.savestates.set(command.label, blob);
        return this.ok({ kind: 'savestate', label: command.label, sha256: sha256(blob) });
      }

      case 'loadState': {
        const blob = this.savestates.get(command.label);
        if (!blob) {
          return {
            id: 0,
            ok: false,
            frame: this.state.frame,
            error: { code: 'no_such_savestate', message: `No savestate labelled "${command.label}"` },
          };
        }
        const parsed = JSON.parse(blob) as { frame: number; ram: string; heldByPort: string[][] };
        this.state = {
          frame: parsed.frame,
          ram: new Uint8Array(Buffer.from(parsed.ram, 'base64')),
          heldByPort: parsed.heldByPort,
        };
        return this.ok({ kind: 'savestate', label: command.label, sha256: sha256(blob) });
      }

      default: {
        const exhaustive: never = command;
        return {
          id: 0,
          ok: false,
          error: { code: 'unsupported', message: `Unsupported command: ${JSON.stringify(exhaustive)}` },
        };
      }
    }
  }

  /**
   * One frame of the toy machine.
   *
   * Holding A drains stamina; Left/Right move the player. This is enough
   * behaviour for a differential RAM search to have a real answer to find.
   */
  private tick(): void {
    const held = new Set(this.state.heldByPort[0] ?? []);
    const ram = this.state.ram;

    const stamina = ram[MOCK_STAMINA_ADDRESS]!;
    if (held.has('A')) {
      ram[MOCK_STAMINA_ADDRESS] = Math.max(0, stamina - 3);
    } else if (this.state.frame % 8 === 0) {
      ram[MOCK_STAMINA_ADDRESS] = Math.min(100, stamina + 1);
    }

    let playerX = (ram[MOCK_PLAYER_X_ADDRESS]! << 8) | ram[MOCK_PLAYER_X_ADDRESS + 1]!;
    if (held.has('Right')) playerX += 1;
    if (held.has('Left')) playerX -= 1;
    playerX = Math.max(0, Math.min(0x1ff, playerX));
    ram[MOCK_PLAYER_X_ADDRESS] = (playerX >> 8) & 0xff;
    ram[MOCK_PLAYER_X_ADDRESS + 1] = playerX & 0xff;

    // Keep the sprite table consistent with the player position so a
    // reconstruction reflects the same state a RAM watch would report. Both
    // sprites move together: the figure translates rigidly, the way a game
    // repositions every hardware sprite that makes up one object.
    this.writeSpriteX(0, playerX);
    this.writeSpriteX(1, playerX + 16);

    this.state.frame += 1;
  }

  private writeSpriteX(spriteIndex: number, x: number): void {
    const biased = (x + 128) & 0x1ff;
    const offset = spriteIndex * 8;
    this.vdp.sat[offset + 6] = (biased >> 8) & 0x01;
    this.vdp.sat[offset + 7] = biased & 0xff;
    this.vdp.vram[SYNTHETIC_SAT_START + offset + 6] = this.vdp.sat[offset + 6]!;
    this.vdp.vram[SYNTHETIC_SAT_START + offset + 7] = this.vdp.sat[offset + 7]!;
  }

  private readDomain(domain: MemoryDomain, start: number, length: number): Uint8Array | undefined {
    const source = this.domainBytes(domain);
    if (!source) return undefined;
    const out = new Uint8Array(length);
    out.set(source.subarray(start, Math.min(start + length, source.length)));
    return out;
  }

  private domainBytes(domain: MemoryDomain): Uint8Array | undefined {
    switch (domain) {
      case '68K RAM':
        return this.state.ram;
      case 'VRAM':
        return this.vdp.vram;
      case 'CRAM':
        return this.vdp.cram;
      case 'VSRAM':
        return this.vdp.vsram;
      default:
        return undefined;
    }
  }

  private renderFrame(): Uint8Array {
    const frame = createImage(320, 224);
    const objects = reconstructObjects({
      vram: this.vdp.vram,
      cram: this.vdp.cram,
      sat: this.vdp.sat,
    });

    for (const object of objects) {
      for (let y = 0; y < object.height; y += 1) {
        for (let x = 0; x < object.width; x += 1) {
          const source = (y * object.width + x) * 4;
          if (object.image.data[source + 3] === 0) continue;
          const destX = object.x + x;
          const destY = object.y + y;
          if (destX < 0 || destY < 0 || destX >= 320 || destY >= 224) continue;
          const dest = (destY * 320 + destX) * 4;
          frame.data.set(object.image.data.subarray(source, source + 4), dest);
        }
      }
    }

    return encodePng(frame);
  }

  private status(): EmulatorStatus {
    return {
      emulator: 'ROMLab Mock',
      emulatorVersion: this.options.emulatorVersion ?? '0.2.0',
      core: this.options.core ?? 'synthetic-genesis',
      romSha256: this.options.romSha256,
      frame: this.state.frame,
      paused: true,
    };
  }

  private ok(result: NonNullable<Extract<BridgeResponse, { ok: true }>['result']>): BridgeResponse {
    return { id: 0, ok: true, frame: this.state.frame, result };
  }
}

function freshState(): MockState {
  const ram = new Uint8Array(RAM_SIZE);
  ram[MOCK_STAMINA_ADDRESS] = 100;
  ram[MOCK_PLAYER_X_ADDRESS] = 0;
  ram[MOCK_PLAYER_X_ADDRESS + 1] = 100;
  return { frame: 0, ram, heldByPort: [[], []] };
}
