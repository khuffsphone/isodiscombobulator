import { sha1, sha256 } from '@romlab/core';
import type { RomRecord } from '@romlab/schema';

import { readHeader, looksLikeGenesisRom, NotAGenesisRom } from './header.js';
import { normalizeRom } from './rom.js';

export interface IdentifiedRom {
  record: RomRecord;
  /** Normalised image, kept in memory only. Never written to the workspace. */
  bytes: Uint8Array;
}

/**
 * Turns an operator's file into an immutable identity record.
 *
 * Identity is computed over the *normalised* image, so the same cartridge
 * dumped as .bin and as .smd produces the same hash and the same workspace
 * entry. The bytes are returned to the caller for analysis but are never
 * persisted by ROMLab.
 */
export function identifyRom(
  raw: Uint8Array,
  options: { sourcePath: string; importedAt?: string },
): IdentifiedRom {
  const normalized = normalizeRom(raw);

  if (!looksLikeGenesisRom(normalized.bytes)) {
    throw new NotAGenesisRom(
      `${options.sourcePath} does not carry a Sega cartridge header at 0x100. ` +
        'ROMLab will not guess at a platform.',
    );
  }

  const header = readHeader(normalized.bytes);

  return {
    bytes: normalized.bytes,
    record: {
      sha256: sha256(normalized.bytes),
      sha1: sha1(normalized.bytes),
      platform: 'genesis',
      byteLength: normalized.bytes.length,
      sourceFormat: normalized.sourceFormat,
      sourcePath: options.sourcePath,
      importedAt: options.importedAt ?? new Date().toISOString(),
      header: { ...header },
    },
  };
}
