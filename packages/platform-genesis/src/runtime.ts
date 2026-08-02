import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { assertPrivateDestination, sha256, type Workspace } from '@romlab/core';
import {
  ROMLAB_VERSION,
  findDomain,
  type CaptureManifest,
  type EvidenceInput,
  type EvidenceRecord,
} from '@romlab/schema';

import { encodePng } from './png.js';
import { reconstructObjects, type ReconstructedObject } from './vdp.js';

export const RECONSTRUCTOR = { name: 'genesis-vdp-reconstructor', version: ROMLAB_VERSION };

export interface CaptureReconstructOptions {
  /**
   * Byte offset of the sprite attribute table inside the captured VRAM.
   *
   * Deliberately required rather than defaulted. The SAT address comes from VDP
   * register 5, which BizHawk's Genesis cores do not expose as a memory domain,
   * so ROMLab cannot read it back from a capture. Guessing a common address
   * would silently produce plausible-looking objects from the wrong bytes,
   * which is precisely the failure this product exists to avoid.
   */
  satStart: number;
  /** Drop objects below this pixel area; HUD dots and debris are rarely useful. */
  minObjectArea?: number;
  /** Write reconstructed PNGs. Always lands under `private-repro`. */
  writeImages?: boolean;
  maxObjects?: number;
}

export interface ReconstructionResult {
  objects: ReconstructedObject[];
  records: EvidenceRecord[];
  imagePaths: string[];
}

/**
 * Turns one captured frame of VDP state into recognisable objects and evidence.
 *
 * This is the step the runtime-first architecture is built around: the game has
 * already decompressed its own tiles into VRAM and assembled them through the
 * sprite table, so what comes out is the pose the player actually saw rather
 * than a guess about what some cartridge offset might mean.
 */
export function reconstructCapture(
  workspace: Workspace,
  manifest: CaptureManifest,
  options: CaptureReconstructOptions,
): ReconstructionResult {
  const vramEntry = findDomain(manifest, 'VRAM');
  const cramEntry = findDomain(manifest, 'CRAM');

  if (!vramEntry?.path || !cramEntry?.path) {
    throw new Error(
      `Capture ${manifest.captureId} does not carry both VRAM and CRAM dumps; ` +
        'sprite reconstruction needs tiles and a palette from the same frame.',
    );
  }

  const vram = readDump(workspace, vramEntry.path, vramEntry.sha256);
  const cram = readDump(workspace, cramEntry.path, cramEntry.sha256);

  const sat = vram.subarray(options.satStart, options.satStart + 80 * 8);
  const objects = reconstructObjects({
    vram,
    cram,
    sat,
    ...(options.minObjectArea !== undefined ? { minObjectArea: options.minObjectArea } : {}),
  }).slice(0, options.maxObjects ?? 64);

  const imagePaths: string[] = [];
  const inputs: EvidenceInput[] = [];

  objects.forEach((object, index) => {
    let artifactPath: string | undefined;

    if (options.writeImages) {
      const directory = workspace.privatePath('reconstructions', manifest.captureId);
      assertPrivateDestination(directory);
      mkdirSync(directory, { recursive: true });

      const fileName = `object-${String(index).padStart(2, '0')}.png`;
      const absolute = path.join(directory, fileName);
      writeFileSync(absolute, encodePng(object.image));

      artifactPath = path.posix.join('private-repro', 'reconstructions', manifest.captureId, fileName);
      imagePaths.push(absolute);
    }

    inputs.push({
      romSha256: manifest.romSha256,
      kind: 'sprite_reconstruction',
      subject: `Object ${index} — ${object.sprites.length} hardware sprite(s) — frame ${manifest.frame}`,
      origin: 'runtime_reconstruction',
      verification: 'runtime_observed',
      confidence: confidenceFor(object),
      locator: {
        captureId: manifest.captureId,
        frame: manifest.frame,
        domain: 'VRAM',
        domainStart: object.vramStart,
        domainLength: object.vramEnd - object.vramStart,
        ...(artifactPath ? { artifactPath } : {}),
      },
      producer: RECONSTRUCTOR,
      transformations: [
        { name: 'vdp:parse-sprite-table', version: ROMLAB_VERSION, params: { satStart: options.satStart } },
        { name: 'vdp:reconstruct-sprites', version: ROMLAB_VERSION },
      ],
      derivedFrom: [],
      data: {
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
        spriteCount: object.sprites.length,
        spriteIndices: object.sprites.map((s) => s.index),
        paletteLines: object.paletteLines,
        vramStart: object.vramStart,
        vramEnd: object.vramEnd,
        emulator: `${manifest.emulator.name} ${manifest.emulator.version}`,
        core: manifest.emulator.core,
        // "Which cartridge bytes produced these tiles" is a separate question
        // that runtime capture alone cannot answer.
        romOrigin: 'unresolved',
      },
    });
  });

  return { objects, records: workspace.ledger.appendAll(inputs), imagePaths };
}

/**
 * Confidence here is a ranking signal, not a probability. Multi-sprite objects
 * of a plausible on-screen size are more likely to be a real game object than a
 * lone 8x8 cell, which is as much as the geometry can tell us.
 */
function confidenceFor(object: ReconstructedObject): number {
  const area = object.width * object.height;
  const sizeScore = Math.min(area / (64 * 64), 1);
  const groupScore = Math.min(object.sprites.length / 4, 1);
  return Math.round((0.5 + sizeScore * 0.25 + groupScore * 0.25) * 100) / 100;
}

function readDump(workspace: Workspace, relativePath: string, expectedSha256: string): Uint8Array {
  const absolute = path.join(workspace.root, relativePath);
  const bytes = new Uint8Array(readFileSync(absolute));

  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new Error(
      `Capture dump ${relativePath} hashes to ${actual} but its manifest says ${expectedSha256}. ` +
        'Refusing to reconstruct from bytes that do not match the recorded evidence.',
    );
  }

  return bytes;
}
