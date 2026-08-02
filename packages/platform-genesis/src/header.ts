/**
 * The Sega cartridge header at 0x100 of a normalised image.
 *
 * Everything here is declared by the cartridge about itself. It is strong
 * evidence of identity and nothing more — a header field is not an observation
 * of behaviour, so header-derived findings stay at candidate tier apart from
 * the identity record itself.
 */

export const HEADER_OFFSET = 0x100;
export const CHECKSUM_OFFSET = 0x18e;
export const CHECKSUM_DATA_START = 0x200;

export interface GenesisHeader {
  consoleName: string;
  copyright: string;
  domesticTitle: string;
  internationalTitle: string;
  serial: string;
  /** Checksum the cartridge declares at 0x18E. */
  declaredChecksum: number;
  /** Checksum ROMLab recomputes over the image. */
  computedChecksum: number;
  checksumMatches: boolean;
  deviceSupport: string;
  romStart: number;
  romEnd: number;
  ramStart: number;
  ramEnd: number;
  sram?: { active: boolean; start: number; end: number; type: string };
  region: string;
  notes: string;
}

export class NotAGenesisRom extends Error {}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const code = bytes[offset + i];
    if (code === undefined) break;
    // Cartridge text is space-padded ASCII; anything else is a decoding smell.
    out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ' ';
  }
  return out.trim().replace(/\s+/g, ' ');
}

function be16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function be32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

export function looksLikeGenesisRom(bytes: Uint8Array): boolean {
  if (bytes.length < CHECKSUM_DATA_START) return false;
  const name = ascii(bytes, HEADER_OFFSET, 16).toUpperCase();
  return name.includes('SEGA');
}

/**
 * The cartridge checksum: the 16-bit sum of every big-endian word from 0x200
 * to the end of the image. An odd trailing byte is ignored, matching the
 * hardware boot check.
 */
export function computeChecksum(bytes: Uint8Array): number {
  let sum = 0;
  const end = bytes.length - (bytes.length % 2);
  for (let i = CHECKSUM_DATA_START; i < end; i += 2) {
    sum = (sum + be16(bytes, i)) & 0xffff;
  }
  return sum;
}

export function readHeader(bytes: Uint8Array): GenesisHeader {
  if (bytes.length < 0x200) {
    throw new NotAGenesisRom(`Image is only ${bytes.length} bytes; a Genesis header needs 0x200.`);
  }

  const declaredChecksum = be16(bytes, CHECKSUM_OFFSET);
  const computedChecksum = computeChecksum(bytes);

  const header: GenesisHeader = {
    consoleName: ascii(bytes, 0x100, 16),
    copyright: ascii(bytes, 0x110, 16),
    domesticTitle: ascii(bytes, 0x120, 48),
    internationalTitle: ascii(bytes, 0x150, 48),
    serial: ascii(bytes, 0x180, 14),
    declaredChecksum,
    computedChecksum,
    checksumMatches: declaredChecksum === computedChecksum,
    deviceSupport: ascii(bytes, 0x190, 16),
    romStart: be32(bytes, 0x1a0),
    romEnd: be32(bytes, 0x1a4),
    ramStart: be32(bytes, 0x1a8),
    ramEnd: be32(bytes, 0x1ac),
    region: ascii(bytes, 0x1f0, 16),
    notes: ascii(bytes, 0x1c8, 40),
  };

  // The SRAM block is only meaningful when it opens with the "RA" marker.
  if (ascii(bytes, 0x1b0, 2) === 'RA') {
    const flags = bytes[0x1b2] ?? 0;
    header.sram = {
      active: (flags & 0x40) !== 0,
      start: be32(bytes, 0x1b4),
      end: be32(bytes, 0x1b8),
      type: (flags & 0x18) === 0x10 ? 'even-bytes' : (flags & 0x18) === 0x18 ? 'odd-bytes' : 'both',
    };
  }

  return header;
}
