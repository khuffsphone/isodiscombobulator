/**
 * Genesis / Mega Drive ROM container handling.
 *
 * ROMLab normalises every image to a plain big-endian binary before anything
 * else touches it, so an offset quoted in a finding means the same thing
 * whether the operator supplied a .bin, .gen or .smd dump.
 */

export type RomFormat = 'bin' | 'smd';

export const SMD_BLOCK_SIZE = 16384;
export const SMD_HEADER_SIZE = 512;

export interface NormalizedRom {
  /** De-interleaved, header-stripped big-endian image. */
  bytes: Uint8Array;
  sourceFormat: RomFormat;
  /** True when the input needed de-interleaving to become a linear image. */
  wasInterleaved: boolean;
}

/**
 * Super Magic Drive dumps carry a 512-byte copier header and store each 16 KiB
 * block as 8 KiB of odd bytes followed by 8 KiB of even bytes.
 */
export function isSmd(bytes: Uint8Array): boolean {
  if (bytes.length <= SMD_HEADER_SIZE) return false;
  if ((bytes.length - SMD_HEADER_SIZE) % SMD_BLOCK_SIZE !== 0) return false;
  // Bytes 8 and 9 of the copier header are the SMD signature.
  return bytes[8] === 0xaa && bytes[9] === 0xbb;
}

export function deinterleaveSmd(bytes: Uint8Array): Uint8Array {
  const body = bytes.subarray(SMD_HEADER_SIZE);
  if (body.length % SMD_BLOCK_SIZE !== 0) {
    throw new Error(`SMD body is not a whole number of ${SMD_BLOCK_SIZE}-byte blocks`);
  }

  const out = new Uint8Array(body.length);
  const half = SMD_BLOCK_SIZE / 2;

  for (let blockStart = 0; blockStart < body.length; blockStart += SMD_BLOCK_SIZE) {
    for (let i = 0; i < half; i += 1) {
      // First half of the block holds odd byte positions, second half even.
      out[blockStart + i * 2 + 1] = body[blockStart + i]!;
      out[blockStart + i * 2] = body[blockStart + half + i]!;
    }
  }

  return out;
}

export function normalizeRom(bytes: Uint8Array): NormalizedRom {
  if (isSmd(bytes)) {
    return { bytes: deinterleaveSmd(bytes), sourceFormat: 'smd', wasInterleaved: true };
  }
  return { bytes, sourceFormat: 'bin', wasInterleaved: false };
}
