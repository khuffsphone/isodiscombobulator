/**
 * Static candidate discovery.
 *
 * Everything in this file scans cartridge bytes without running the game, so
 * everything in this file produces *candidates*. The functions here deliberately
 * do not construct evidence records; the caller does that with
 * `origin: 'static_analysis'`, and the auditor pins the result to
 * `unverified_candidate` no matter how confident a heuristic feels.
 *
 * This is the capability the runtime-first proposal demoted, and it stays
 * demoted: useful for narrowing where to look, never for saying what something is.
 */

import { TILE_BYTES, TILE_SIZE, decodeTile } from './vdp.js';

export interface EntropyBlock {
  offset: number;
  length: number;
  /** Shannon entropy in bits per byte, 0..8. */
  entropy: number;
}

/**
 * Coarse entropy map. Compressed or encrypted regions sit near 8 bits/byte;
 * code and uncompressed tiles sit lower. Used only to steer attention.
 */
export function entropyMap(bytes: Uint8Array, blockSize = 4096): EntropyBlock[] {
  const blocks: EntropyBlock[] = [];

  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const end = Math.min(offset + blockSize, bytes.length);
    const length = end - offset;
    if (length === 0) continue;

    const counts = new Uint32Array(256);
    for (let i = offset; i < end; i += 1) counts[bytes[i]!]! += 1;

    let entropy = 0;
    for (const count of counts) {
      if (count === 0) continue;
      const p = count / length;
      entropy -= p * Math.log2(p);
    }

    blocks.push({ offset, length, entropy });
  }

  return blocks;
}

export interface StringCandidate {
  offset: number;
  text: string;
}

/** Bounded printable-ASCII run finder. */
export function findStrings(
  bytes: Uint8Array,
  options: { minLength?: number; maxResults?: number } = {},
): StringCandidate[] {
  const minLength = options.minLength ?? 5;
  const maxResults = options.maxResults ?? 500;
  const found: StringCandidate[] = [];

  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    const byte = bytes[i];
    const printable = byte !== undefined && byte >= 0x20 && byte <= 0x7e;

    if (printable && start === -1) start = i;
    if (!printable && start !== -1) {
      if (i - start >= minLength) {
        found.push({ offset: start, text: String.fromCharCode(...bytes.subarray(start, i)) });
        if (found.length >= maxResults) return found;
      }
      start = -1;
    }
  }

  return found;
}

export interface TileBankCandidate {
  offset: number;
  tileCount: number;
  /** 0..1. Relative ranking signal only — not a probability of correctness. */
  score: number;
}

/**
 * Ranks regions that *could* be uncompressed 4bpp tile data.
 *
 * The signal is weak by construction: 4bpp tiles tend to use a limited set of
 * palette indices with spatial coherence between neighbouring pixels. Plenty of
 * non-graphics data scores well, which is exactly why the result is a candidate.
 */
export function findTileBanks(
  bytes: Uint8Array,
  options: { tilesPerBank?: number; maxResults?: number; stride?: number } = {},
): TileBankCandidate[] {
  const tilesPerBank = options.tilesPerBank ?? 64;
  const maxResults = options.maxResults ?? 16;
  const bankBytes = tilesPerBank * TILE_BYTES;
  const stride = options.stride ?? bankBytes;

  const candidates: TileBankCandidate[] = [];

  for (let offset = 0; offset + bankBytes <= bytes.length; offset += stride) {
    const bank = bytes.subarray(offset, offset + bankBytes);

    const used = new Set<number>();
    let coherent = 0;
    let compared = 0;
    let nonZero = 0;

    for (let t = 0; t < tilesPerBank; t += 1) {
      const tile = decodeTile(bank, t * TILE_BYTES);
      for (let y = 0; y < TILE_SIZE; y += 1) {
        for (let x = 0; x < TILE_SIZE; x += 1) {
          const index = tile[y * TILE_SIZE + x]!;
          used.add(index);
          if (index !== 0) nonZero += 1;
          if (x > 0) {
            compared += 1;
            if (tile[y * TILE_SIZE + x - 1] === index) coherent += 1;
          }
        }
      }
    }

    // All-zero or all-one-value regions are padding, not art.
    if (used.size < 3 || nonZero === 0) continue;

    const coherence = compared > 0 ? coherent / compared : 0;
    const fill = nonZero / (tilesPerBank * TILE_SIZE * TILE_SIZE);
    const spread = used.size / 16;

    // Weighted so that a plausible bank needs horizontal runs *and* a real
    // spread of indices *and* meaningful non-transparent coverage.
    const score = clamp01(coherence * 0.5 + spread * 0.25 + Math.min(fill * 2, 1) * 0.25);
    candidates.push({ offset, tileCount: tilesPerBank, score });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

export interface PaletteCandidate {
  offset: number;
  /** The 16 raw CRAM words as stored. */
  words: number[];
  score: number;
}

/**
 * Finds 16-word regions that are structurally valid CRAM palettes.
 *
 * A Genesis colour word must have zeros in bits 0, 4, 8 and 12-15. Byte runs
 * that satisfy that for sixteen consecutive words are structurally compatible
 * with a palette — which is a statement about bit layout, not about whether the
 * game ever loads those bytes into CRAM.
 */
export function findPalettes(
  bytes: Uint8Array,
  options: { maxResults?: number; stride?: number } = {},
): PaletteCandidate[] {
  const maxResults = options.maxResults ?? 16;
  const stride = options.stride ?? 2;
  const candidates: PaletteCandidate[] = [];

  for (let offset = 0; offset + 32 <= bytes.length; offset += stride) {
    const words: number[] = [];
    let valid = true;
    const distinct = new Set<number>();

    for (let i = 0; i < 16; i += 1) {
      const word = ((bytes[offset + i * 2] ?? 0) << 8) | (bytes[offset + i * 2 + 1] ?? 0);
      if ((word & 0xf111) !== 0) {
        valid = false;
        break;
      }
      words.push(word);
      distinct.add(word);
    }

    if (!valid) continue;
    // A run of sixteen identical words is almost always padding.
    if (distinct.size < 4) continue;

    candidates.push({ offset, words, score: clamp01(distinct.size / 16) });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
