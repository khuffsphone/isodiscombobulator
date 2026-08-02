/**
 * Genesis VDP decoding and runtime reconstruction.
 *
 * This module is the reason ROMLab is runtime-first. A Genesis cartridge
 * almost never stores a fighter as a picture: the game decompresses tiles into
 * VRAM, writes a palette into CRAM, and assembles an object out of hardware
 * sprites through the sprite attribute table. Reading the cartridge gives you
 * tile soup. Reading VRAM + CRAM + SAT at a known frame gives you the pose the
 * player actually saw.
 */

export const TILE_BYTES = 32;
export const TILE_SIZE = 8;
export const CRAM_BYTES = 128;
export const PALETTE_LINES = 4;
export const COLORS_PER_LINE = 16;

/** A decoded 8x8 tile as palette indices, row-major. */
export type Tile = Uint8Array;

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Image {
  width: number;
  height: number;
  /** RGBA8888, row-major, length = width * height * 4. */
  data: Uint8Array;
}

/**
 * Measured VDP output levels for the eight 3-bit channel values at normal
 * intensity. Using the real ladder rather than a linear stretch keeps
 * reconstructed art comparable to a screenshot captured from the same frame.
 */
export const VDP_LEVELS = [0, 52, 87, 116, 144, 172, 206, 255] as const;

/**
 * Decodes a Genesis CRAM word. Layout is `0000 BBB0 GGG0 RRR0`, so each
 * channel is three bits sitting one bit above its nibble boundary.
 */
export function decodeCramColor(word: number): Rgba {
  const r = VDP_LEVELS[(word >> 1) & 0x7]!;
  const g = VDP_LEVELS[(word >> 5) & 0x7]!;
  const b = VDP_LEVELS[(word >> 9) & 0x7]!;
  return { r, g, b, a: 255 };
}

export type Palette = Rgba[];

/** Splits a 128-byte CRAM dump into the four 16-colour palette lines. */
export function decodeCram(cram: Uint8Array): Palette[] {
  const lines: Palette[] = [];
  for (let line = 0; line < PALETTE_LINES; line += 1) {
    const colors: Palette = [];
    for (let index = 0; index < COLORS_PER_LINE; index += 1) {
      const offset = (line * COLORS_PER_LINE + index) * 2;
      const word = ((cram[offset] ?? 0) << 8) | (cram[offset + 1] ?? 0);
      colors.push(decodeCramColor(word));
    }
    lines.push(colors);
  }
  return lines;
}

/**
 * Decodes one 8x8 4bpp tile. Each row is four bytes; each byte holds two
 * pixels with the left pixel in the high nibble.
 */
export function decodeTile(bytes: Uint8Array, offset = 0): Tile {
  const tile = new Uint8Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < TILE_BYTES; i += 1) {
    const byte = bytes[offset + i] ?? 0;
    tile[i * 2] = (byte >> 4) & 0xf;
    tile[i * 2 + 1] = byte & 0xf;
  }
  return tile;
}

// --- Sprite attribute table -------------------------------------------------

export interface SpriteAttribute {
  /** Index of this entry within the sprite attribute table. */
  index: number;
  /** Screen position. The VDP stores these with a 128-pixel bias. */
  x: number;
  y: number;
  /** Size in 8x8 cells. */
  widthCells: number;
  heightCells: number;
  tileIndex: number;
  paletteLine: number;
  hFlip: boolean;
  vFlip: boolean;
  priority: boolean;
  link: number;
}

export const MAX_SPRITES_H40 = 80;
export const MAX_SPRITES_H32 = 64;

/**
 * Walks the sprite attribute table.
 *
 * The SAT is a linked list, not an array: entry 0 names the next entry, and a
 * link of 0 ends the list. Following the links (rather than reading all 80
 * slots) is what distinguishes sprites the VDP actually drew this frame from
 * stale slots left over from an earlier scene.
 */
export function parseSpriteTable(
  sat: Uint8Array,
  options: { maxSprites?: number } = {},
): SpriteAttribute[] {
  const maxSprites = options.maxSprites ?? MAX_SPRITES_H40;
  const sprites: SpriteAttribute[] = [];
  const visited = new Set<number>();

  let index = 0;
  while (sprites.length < maxSprites) {
    if (visited.has(index)) break; // A corrupt table can loop; refuse to spin.
    visited.add(index);

    const offset = index * 8;
    if (offset + 8 > sat.length) break;

    const y = (((sat[offset] ?? 0) << 8) | (sat[offset + 1] ?? 0)) & 0x3ff;
    const sizeByte = sat[offset + 2] ?? 0;
    const link = (sat[offset + 3] ?? 0) & 0x7f;
    const attr = ((sat[offset + 4] ?? 0) << 8) | (sat[offset + 5] ?? 0);
    const x = (((sat[offset + 6] ?? 0) << 8) | (sat[offset + 7] ?? 0)) & 0x1ff;

    sprites.push({
      index,
      x: x - 128,
      y: y - 128,
      widthCells: ((sizeByte >> 2) & 0x3) + 1,
      heightCells: (sizeByte & 0x3) + 1,
      tileIndex: attr & 0x7ff,
      paletteLine: (attr >> 13) & 0x3,
      hFlip: (attr & 0x0800) !== 0,
      vFlip: (attr & 0x1000) !== 0,
      priority: (attr & 0x8000) !== 0,
      link,
    });

    if (link === 0) break;
    index = link;
  }

  return sprites;
}

// --- Rendering --------------------------------------------------------------

export function createImage(width: number, height: number): Image {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function putPixel(image: Image, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color.r;
  image.data[offset + 1] = color.g;
  image.data[offset + 2] = color.b;
  image.data[offset + 3] = color.a;
}

/**
 * Draws one hardware sprite into `image` at (originX, originY).
 *
 * Tiles within a sprite run column-major: for an H x V sprite the tile at
 * column c, row r is `tileIndex + c * V + r`. Getting this backwards is the
 * classic way to produce a scrambled fighter, so it is asserted by test.
 */
export function drawSprite(
  image: Image,
  sprite: SpriteAttribute,
  vram: Uint8Array,
  palettes: Palette[],
  originX: number,
  originY: number,
): void {
  const palette = palettes[sprite.paletteLine] ?? palettes[0] ?? [];

  for (let col = 0; col < sprite.widthCells; col += 1) {
    for (let row = 0; row < sprite.heightCells; row += 1) {
      const tileNumber = sprite.tileIndex + col * sprite.heightCells + row;
      const tile = decodeTile(vram, tileNumber * TILE_BYTES);

      // Flips apply to the whole sprite, so a flipped sprite also reverses
      // the order its cells are laid out in.
      const cellX = sprite.hFlip ? sprite.widthCells - 1 - col : col;
      const cellY = sprite.vFlip ? sprite.heightCells - 1 - row : row;

      for (let py = 0; py < TILE_SIZE; py += 1) {
        for (let px = 0; px < TILE_SIZE; px += 1) {
          const index = tile[py * TILE_SIZE + px] ?? 0;
          if (index === 0) continue; // Colour 0 is transparent on Genesis.

          const sx = sprite.hFlip ? TILE_SIZE - 1 - px : px;
          const sy = sprite.vFlip ? TILE_SIZE - 1 - py : py;
          const color = palette[index];
          if (!color) continue;

          putPixel(
            image,
            originX + cellX * TILE_SIZE + sx,
            originY + cellY * TILE_SIZE + sy,
            color,
          );
        }
      }
    }
  }
}

// --- Object grouping --------------------------------------------------------

export interface ReconstructedObject {
  /** Hardware sprites the VDP composited into this object. */
  sprites: SpriteAttribute[];
  x: number;
  y: number;
  width: number;
  height: number;
  image: Image;
  paletteLines: number[];
  /** Byte range of VRAM the object's tiles came from. */
  vramStart: number;
  vramEnd: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxOf(sprite: SpriteAttribute): Box {
  return {
    x: sprite.x,
    y: sprite.y,
    width: sprite.widthCells * TILE_SIZE,
    height: sprite.heightCells * TILE_SIZE,
  };
}

function boxesTouch(a: Box, b: Box, tolerance: number): boolean {
  return (
    a.x - tolerance < b.x + b.width &&
    b.x - tolerance < a.x + a.width &&
    a.y - tolerance < b.y + b.height &&
    b.y - tolerance < a.y + a.height
  );
}

/**
 * Groups hardware sprites into coherent objects.
 *
 * A boxer is drawn as many sprites because the VDP caps sprite size at 4x4
 * cells. Adjacency grouping is what turns "seven sprites" back into "one
 * fighter", which is the difference between a browsable asset and a pile of
 * tile grids.
 */
export function groupSprites(
  sprites: readonly SpriteAttribute[],
  tolerance = 1,
): SpriteAttribute[][] {
  const parent = sprites.map((_, i) => i);

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < sprites.length; i += 1) {
    for (let j = i + 1; j < sprites.length; j += 1) {
      if (boxesTouch(boxOf(sprites[i]!), boxOf(sprites[j]!), tolerance)) union(i, j);
    }
  }

  const groups = new Map<number, SpriteAttribute[]>();
  sprites.forEach((sprite, i) => {
    const root = find(i);
    const existing = groups.get(root);
    if (existing) existing.push(sprite);
    else groups.set(root, [sprite]);
  });

  return [...groups.values()];
}

export interface ReconstructOptions {
  vram: Uint8Array;
  cram: Uint8Array;
  /** Sprite attribute table bytes, usually sliced out of the VRAM dump. */
  sat: Uint8Array;
  maxSprites?: number;
  /** Pixels of slack when deciding whether two sprites belong to one object. */
  groupTolerance?: number;
  /** Discard objects smaller than this, which are usually HUD dots or debris. */
  minObjectArea?: number;
}

/**
 * Reconstructs every on-screen object from one frame of captured VDP state.
 */
export function reconstructObjects(options: ReconstructOptions): ReconstructedObject[] {
  const palettes = decodeCram(options.cram);
  const sprites = parseSpriteTable(options.sat, {
    ...(options.maxSprites !== undefined ? { maxSprites: options.maxSprites } : {}),
  });
  const minArea = options.minObjectArea ?? 0;

  const objects: ReconstructedObject[] = [];

  for (const group of groupSprites(sprites, options.groupTolerance ?? 1)) {
    const boxes = group.map(boxOf);
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));

    const width = maxX - minX;
    const height = maxY - minY;
    if (width <= 0 || height <= 0 || width * height < minArea) continue;

    const image = createImage(width, height);
    let vramStart = Number.POSITIVE_INFINITY;
    let vramEnd = 0;

    // Draw in reverse link order so that lower-numbered sprites — which the VDP
    // gives priority — end up on top.
    for (const sprite of [...group].reverse()) {
      drawSprite(image, sprite, options.vram, palettes, sprite.x - minX, sprite.y - minY);
      const cells = sprite.widthCells * sprite.heightCells;
      vramStart = Math.min(vramStart, sprite.tileIndex * TILE_BYTES);
      vramEnd = Math.max(vramEnd, (sprite.tileIndex + cells) * TILE_BYTES);
    }

    objects.push({
      sprites: group,
      x: minX,
      y: minY,
      width,
      height,
      image,
      paletteLines: [...new Set(group.map((s) => s.paletteLine))].sort(),
      vramStart: Number.isFinite(vramStart) ? vramStart : 0,
      vramEnd,
    });
  }

  return objects;
}

// --- Background planes ------------------------------------------------------

export interface PlaneEntry {
  tileIndex: number;
  paletteLine: number;
  hFlip: boolean;
  vFlip: boolean;
  priority: boolean;
}

export function decodePlaneEntry(word: number): PlaneEntry {
  return {
    tileIndex: word & 0x7ff,
    paletteLine: (word >> 13) & 0x3,
    hFlip: (word & 0x0800) !== 0,
    vFlip: (word & 0x1000) !== 0,
    priority: (word & 0x8000) !== 0,
  };
}

/**
 * Renders a scroll plane from its nametable. Used to separate ring, crowd and
 * HUD layers from the fighters in a captured frame.
 */
export function reconstructPlane(options: {
  vram: Uint8Array;
  cram: Uint8Array;
  /** Byte offset of the nametable within the VRAM dump. */
  nametableStart: number;
  widthCells: number;
  heightCells: number;
}): Image {
  const palettes = decodeCram(options.cram);
  const image = createImage(options.widthCells * TILE_SIZE, options.heightCells * TILE_SIZE);

  for (let row = 0; row < options.heightCells; row += 1) {
    for (let col = 0; col < options.widthCells; col += 1) {
      const offset = options.nametableStart + (row * options.widthCells + col) * 2;
      const word = ((options.vram[offset] ?? 0) << 8) | (options.vram[offset + 1] ?? 0);
      const entry = decodePlaneEntry(word);
      const tile = decodeTile(options.vram, entry.tileIndex * TILE_BYTES);
      const palette = palettes[entry.paletteLine] ?? palettes[0] ?? [];

      for (let py = 0; py < TILE_SIZE; py += 1) {
        for (let px = 0; px < TILE_SIZE; px += 1) {
          const index = tile[py * TILE_SIZE + px] ?? 0;
          if (index === 0) continue;
          const color = palette[index];
          if (!color) continue;
          const sx = entry.hFlip ? TILE_SIZE - 1 - px : px;
          const sy = entry.vFlip ? TILE_SIZE - 1 - py : py;
          putPixel(image, col * TILE_SIZE + sx, row * TILE_SIZE + sy, color);
        }
      }
    }
  }

  return image;
}

/**
 * VDP register decoding for the addresses ROMLab needs. Register numbers follow
 * the hardware documentation; values come from the bridge's register dump.
 */
export function planeAddresses(registers: Uint8Array): {
  planeA: number;
  planeB: number;
  spriteTable: number;
  windowPlane: number;
} {
  return {
    planeA: ((registers[0x02] ?? 0) & 0x38) << 10,
    planeB: ((registers[0x04] ?? 0) & 0x07) << 13,
    spriteTable: ((registers[0x05] ?? 0) & 0x7f) << 9,
    windowPlane: ((registers[0x03] ?? 0) & 0x3e) << 10,
  };
}
