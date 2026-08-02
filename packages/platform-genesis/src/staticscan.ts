import { ROMLAB_VERSION, type EvidenceInput, type EvidenceRecord } from '@romlab/schema';
import type { Workspace } from '@romlab/core';

import { entropyMap, findPalettes, findStrings, findTileBanks } from './candidates.js';
import { readHeader } from './header.js';

export const SCANNER = { name: 'genesis-static-scanner', version: ROMLAB_VERSION };

export interface StaticScanOptions {
  maxTileBanks?: number;
  maxPalettes?: number;
  maxStrings?: number;
}

/**
 * Runs the static scanners and files their output as candidates.
 *
 * Every record here is `origin: 'static_analysis'`, which the auditor pins to
 * `unverified_candidate` regardless of how high a heuristic scores. The value
 * of this pass is narrowing where to point the emulator, not deciding what
 * anything is.
 */
export function scanRomStatically(
  workspace: Workspace,
  romBytes: Uint8Array,
  romSha256: string,
  options: StaticScanOptions = {},
): EvidenceRecord[] {
  const header = readHeader(romBytes);
  const inputs: EvidenceInput[] = [];

  // Cartridge identity is the one static claim that is genuinely a measurement:
  // the header is either there and self-consistent or it is not.
  inputs.push({
    romSha256,
    kind: 'cartridge_identity',
    subject: `${header.internationalTitle || header.domesticTitle || 'Untitled cartridge'} (${header.serial})`,
    origin: 'static_analysis',
    verification: 'unverified_candidate',
    confidence: header.checksumMatches ? 0.99 : 0.6,
    locator: { romOffset: 0x100, romLength: 0x100 },
    producer: SCANNER,
    transformations: [{ name: 'parse:sega-header', version: ROMLAB_VERSION }],
    derivedFrom: [],
    data: { ...header },
  });

  inputs.push({
    romSha256,
    kind: 'memory_region',
    subject: `Declared ROM ${hex(header.romStart)}–${hex(header.romEnd)}, RAM ${hex(header.ramStart)}–${hex(header.ramEnd)}`,
    origin: 'static_analysis',
    verification: 'unverified_candidate',
    confidence: 0.8,
    locator: { romOffset: 0x1a0, romLength: 0x10 },
    producer: SCANNER,
    transformations: [{ name: 'parse:sega-header', version: ROMLAB_VERSION }],
    derivedFrom: [],
    data: {
      romStart: header.romStart,
      romEnd: header.romEnd,
      ramStart: header.ramStart,
      ramEnd: header.ramEnd,
      sram: header.sram ?? null,
      note: 'Declared by the cartridge header; not observed at runtime.',
    },
  });

  for (const bank of findTileBanks(romBytes, { maxResults: options.maxTileBanks ?? 8 })) {
    inputs.push({
      romSha256,
      kind: 'graphics_candidate',
      subject: `Possible 4bpp tile bank at ${hex(bank.offset)}`,
      origin: 'static_analysis',
      verification: 'unverified_candidate',
      confidence: bank.score,
      locator: { romOffset: bank.offset, romLength: bank.tileCount * 32 },
      producer: SCANNER,
      transformations: [{ name: 'scan:tile-bank-ranking', version: ROMLAB_VERSION }],
      derivedFrom: [],
      data: {
        tileCount: bank.tileCount,
        note: 'Structurally compatible with 4bpp tiles. Not decoded by the game; not observed in VRAM.',
      },
    });
  }

  for (const palette of findPalettes(romBytes, { maxResults: options.maxPalettes ?? 8 })) {
    inputs.push({
      romSha256,
      kind: 'palette_candidate',
      subject: `Structurally valid CRAM palette at ${hex(palette.offset)}`,
      origin: 'static_analysis',
      verification: 'unverified_candidate',
      confidence: palette.score,
      locator: { romOffset: palette.offset, romLength: 32 },
      producer: SCANNER,
      transformations: [{ name: 'scan:cram-palette-shape', version: ROMLAB_VERSION }],
      derivedFrom: [],
      data: {
        words: palette.words,
        note: 'Bit layout matches a Genesis palette. Whether the game ever loads it into CRAM is unknown.',
      },
    });
  }

  const strings = findStrings(romBytes, { minLength: 6, maxResults: options.maxStrings ?? 40 });
  for (const found of strings) {
    inputs.push({
      romSha256,
      kind: 'string_candidate',
      subject: `Printable ASCII at ${hex(found.offset)}: ${truncate(found.text, 48)}`,
      origin: 'static_analysis',
      verification: 'unverified_candidate',
      confidence: Math.min(found.text.length / 32, 1),
      locator: { romOffset: found.offset, romLength: found.text.length },
      producer: SCANNER,
      transformations: [{ name: 'scan:printable-runs', version: ROMLAB_VERSION }],
      derivedFrom: [],
      data: {
        text: found.text,
        note: 'Raw ASCII. Many Genesis games use a custom text table, so absence here means nothing.',
      },
    });
  }

  const entropy = entropyMap(romBytes, 4096);
  const highEntropy = entropy.filter((block) => block.entropy > 7.5);
  if (highEntropy.length > 0) {
    inputs.push({
      romSha256,
      kind: 'memory_region',
      subject: `${highEntropy.length} high-entropy block(s) — possible compressed or packed data`,
      origin: 'static_analysis',
      verification: 'unverified_candidate',
      confidence: 0.5,
      locator: { romOffset: highEntropy[0]!.offset, romLength: highEntropy[0]!.length },
      producer: SCANNER,
      transformations: [{ name: 'scan:entropy-map', version: ROMLAB_VERSION }],
      derivedFrom: [],
      data: {
        blocks: highEntropy.slice(0, 32).map((b) => ({ offset: b.offset, entropy: Number(b.entropy.toFixed(3)) })),
        note: 'High entropy suggests compression or packed data. It is equally consistent with sample data.',
      },
    });
  }

  return workspace.ledger.appendAll(inputs);
}

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
