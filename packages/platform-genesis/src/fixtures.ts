/**
 * Synthetic Genesis fixtures.
 *
 * ROMLab's test suite and its deterministic mock emulator must never depend on
 * a copyrighted cartridge. These builders produce structurally valid Genesis
 * artifacts — a bootable-looking header, a VDP state containing a known
 * multi-sprite object — so the whole capture and reconstruction loop can be
 * exercised in CI on a machine that has never seen a ROM.
 */

import { CHECKSUM_OFFSET, computeChecksum } from './header.js';
import { SMD_BLOCK_SIZE, SMD_HEADER_SIZE } from './rom.js';
import { TILE_BYTES } from './vdp.js';

export interface SyntheticRomOptions {
  byteLength?: number;
  domesticTitle?: string;
  internationalTitle?: string;
  serial?: string;
  region?: string;
  /** Seed for the deterministic filler payload. */
  seed?: number;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string, length: number): void {
  for (let i = 0; i < length; i += 1) {
    bytes[offset + i] = i < text.length ? text.charCodeAt(i) & 0x7f : 0x20;
  }
}

function writeBe32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** Deterministic, dependency-free PRNG so fixtures are byte-stable across runs. */
function* lcg(seed: number): Generator<number> {
  let state = seed >>> 0;
  for (;;) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield (state >>> 24) & 0xff;
  }
}

export function buildSyntheticRom(options: SyntheticRomOptions = {}): Uint8Array {
  const byteLength = options.byteLength ?? 512 * 1024;
  const bytes = new Uint8Array(byteLength);

  writeAscii(bytes, 0x100, 'SEGA MEGA DRIVE ', 16);
  writeAscii(bytes, 0x110, '(C)ROMLAB 2026.AUG', 16);
  writeAscii(bytes, 0x120, options.domesticTitle ?? 'ROMLAB SYNTHETIC FIXTURE', 48);
  writeAscii(bytes, 0x150, options.internationalTitle ?? 'ROMLAB SYNTHETIC FIXTURE', 48);
  writeAscii(bytes, 0x180, options.serial ?? 'GM 00000000-00', 14);
  writeAscii(bytes, 0x190, 'J', 16);
  writeBe32(bytes, 0x1a0, 0x000000);
  writeBe32(bytes, 0x1a4, byteLength - 1);
  writeBe32(bytes, 0x1a8, 0xff0000);
  writeBe32(bytes, 0x1ac, 0xffffff);
  writeAscii(bytes, 0x1c8, 'Synthetic fixture. Not a commercial cartridge.', 40);
  writeAscii(bytes, 0x1f0, options.region ?? 'JUE', 16);

  // Deterministic payload so checksum and candidate ranking are reproducible.
  const random = lcg(options.seed ?? 0x1234);
  for (let i = 0x200; i < byteLength; i += 1) bytes[i] = random.next().value;

  const checksum = computeChecksum(bytes);
  bytes[CHECKSUM_OFFSET] = (checksum >> 8) & 0xff;
  bytes[CHECKSUM_OFFSET + 1] = checksum & 0xff;

  return bytes;
}

/** Wraps a linear image back into an interleaved SMD container. */
export function toSmd(bytes: Uint8Array): Uint8Array {
  if (bytes.length % SMD_BLOCK_SIZE !== 0) {
    throw new Error(`Image must be a multiple of ${SMD_BLOCK_SIZE} bytes to become an SMD`);
  }

  const out = new Uint8Array(SMD_HEADER_SIZE + bytes.length);
  out[0] = bytes.length / SMD_BLOCK_SIZE;
  out[1] = 0x03;
  out[8] = 0xaa;
  out[9] = 0xbb;
  out[10] = 0x06;

  const half = SMD_BLOCK_SIZE / 2;
  for (let blockStart = 0; blockStart < bytes.length; blockStart += SMD_BLOCK_SIZE) {
    for (let i = 0; i < half; i += 1) {
      out[SMD_HEADER_SIZE + blockStart + i] = bytes[blockStart + i * 2 + 1]!;
      out[SMD_HEADER_SIZE + blockStart + half + i] = bytes[blockStart + i * 2]!;
    }
  }

  return out;
}

export interface SyntheticVdpState {
  vram: Uint8Array;
  cram: Uint8Array;
  vsram: Uint8Array;
  /** The sprite attribute table, also present inside `vram` at `satStart`. */
  sat: Uint8Array;
  satStart: number;
  registers: Uint8Array;
}

/** Colour word helper: three bits per channel, one bit above each nibble. */
export function cramWord(r: number, g: number, b: number): number {
  return ((b & 7) << 9) | ((g & 7) << 5) | ((r & 7) << 1);
}

function fillTile(vram: Uint8Array, tileIndex: number, paletteIndex: number): void {
  const offset = tileIndex * TILE_BYTES;
  const byte = ((paletteIndex & 0xf) << 4) | (paletteIndex & 0xf);
  for (let i = 0; i < TILE_BYTES; i += 1) vram[offset + i] = byte;
}

export const SYNTHETIC_SAT_START = 0xf000;

/**
 * A known scene: two adjacent hardware sprites that together form one object,
 * the way a Genesis game composes a fighter out of several sprites.
 *
 * Sprite 0 is 2x2 cells at (100, 50) using tiles 1-4; sprite 1 is 1x2 cells at
 * (116, 50) using tiles 5-6. Each tile is flooded with a distinct palette index
 * so a reconstruction test can assert exactly which tile landed where — which
 * is how the column-major cell ordering is pinned down.
 */
export function buildSyntheticVdpState(): SyntheticVdpState {
  const vram = new Uint8Array(0x10000);
  const cram = new Uint8Array(128);
  const vsram = new Uint8Array(80);

  // Palette line 0: transparent, red, green, blue.
  const palette = [0, cramWord(7, 0, 0), cramWord(0, 7, 0), cramWord(0, 0, 7)];
  palette.forEach((word, index) => {
    cram[index * 2] = (word >> 8) & 0xff;
    cram[index * 2 + 1] = word & 0xff;
  });

  // Tile 0 stays blank; the VDP treats index 0 as transparent anyway.
  fillTile(vram, 1, 1); // sprite 0, column 0, row 0 -> red
  fillTile(vram, 2, 2); // sprite 0, column 0, row 1 -> green
  fillTile(vram, 3, 3); // sprite 0, column 1, row 0 -> blue
  fillTile(vram, 4, 1); // sprite 0, column 1, row 1 -> red
  fillTile(vram, 5, 2); // sprite 1, column 0, row 0 -> green
  fillTile(vram, 6, 3); // sprite 1, column 0, row 1 -> blue

  const sat = new Uint8Array(80 * 8);
  writeSprite(sat, 0, { y: 50, widthCells: 2, heightCells: 2, link: 1, tileIndex: 1, x: 100 });
  writeSprite(sat, 1, { y: 50, widthCells: 1, heightCells: 2, link: 0, tileIndex: 5, x: 116 });
  vram.set(sat, SYNTHETIC_SAT_START);

  const registers = new Uint8Array(24);
  registers[0x02] = 0x30; // Plane A nametable at 0xC000
  registers[0x04] = 0x07; // Plane B nametable at 0xE000
  registers[0x05] = SYNTHETIC_SAT_START >> 9; // Sprite table at 0xF000

  return { vram, cram, vsram, sat, satStart: SYNTHETIC_SAT_START, registers };
}

function writeSprite(
  sat: Uint8Array,
  index: number,
  sprite: {
    y: number;
    x: number;
    widthCells: number;
    heightCells: number;
    tileIndex: number;
    link: number;
    paletteLine?: number;
    hFlip?: boolean;
    vFlip?: boolean;
    priority?: boolean;
  },
): void {
  const offset = index * 8;
  // The VDP biases both axes by 128.
  const y = (sprite.y + 128) & 0x3ff;
  const x = (sprite.x + 128) & 0x1ff;

  sat[offset] = (y >> 8) & 0x03;
  sat[offset + 1] = y & 0xff;
  sat[offset + 2] = (((sprite.widthCells - 1) & 0x3) << 2) | ((sprite.heightCells - 1) & 0x3);
  sat[offset + 3] = sprite.link & 0x7f;

  const attr =
    ((sprite.priority ? 1 : 0) << 15) |
    ((sprite.paletteLine ?? 0) << 13) |
    ((sprite.vFlip ? 1 : 0) << 12) |
    ((sprite.hFlip ? 1 : 0) << 11) |
    (sprite.tileIndex & 0x7ff);
  sat[offset + 4] = (attr >> 8) & 0xff;
  sat[offset + 5] = attr & 0xff;

  sat[offset + 6] = (x >> 8) & 0x01;
  sat[offset + 7] = x & 0xff;
}

export { writeSprite };
