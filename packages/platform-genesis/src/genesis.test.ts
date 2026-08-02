import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findPalettes, findStrings, findTileBanks, entropyMap } from './candidates.js';
import { buildSyntheticRom, buildSyntheticVdpState, cramWord, toSmd, writeSprite } from './fixtures.js';
import { computeChecksum, readHeader, looksLikeGenesisRom } from './header.js';
import { identifyRom } from './identify.js';
import { encodePng, isPng } from './png.js';
import { deinterleaveSmd, isSmd, normalizeRom } from './rom.js';
import {
  createImage,
  decodeCram,
  decodeCramColor,
  decodeTile,
  groupSprites,
  parseSpriteTable,
  planeAddresses,
  reconstructObjects,
  type Rgba,
} from './vdp.js';

function pixelAt(image: { width: number; data: Uint8Array }, x: number, y: number): Rgba {
  const offset = (y * image.width + x) * 4;
  return {
    r: image.data[offset]!,
    g: image.data[offset + 1]!,
    b: image.data[offset + 2]!,
    a: image.data[offset + 3]!,
  };
}

describe('ROM containers', () => {
  it('round-trips a linear image through SMD interleaving', () => {
    const original = buildSyntheticRom({ byteLength: 64 * 1024 });
    const smd = toSmd(original);

    assert.equal(isSmd(smd), true);
    assert.deepEqual(deinterleaveSmd(smd), original);
  });

  it('leaves a plain binary untouched', () => {
    const original = buildSyntheticRom({ byteLength: 64 * 1024 });
    const normalized = normalizeRom(original);

    assert.equal(normalized.sourceFormat, 'bin');
    assert.equal(normalized.wasInterleaved, false);
    assert.deepEqual(normalized.bytes, original);
  });

  it('gives the same identity for the same cartridge in either container', () => {
    const original = buildSyntheticRom({ byteLength: 64 * 1024 });

    const fromBin = identifyRom(original, { sourcePath: '/roms/f.bin', importedAt: '2026-08-02T00:00:00Z' });
    const fromSmd = identifyRom(toSmd(original), { sourcePath: '/roms/f.smd', importedAt: '2026-08-02T00:00:00Z' });

    assert.equal(fromBin.record.sha256, fromSmd.record.sha256);
    assert.equal(fromSmd.record.sourceFormat, 'smd');
  });

  it('refuses a file with no Sega header rather than guessing', () => {
    assert.throws(
      () => identifyRom(new Uint8Array(64 * 1024), { sourcePath: '/roms/not-a-rom.bin' }),
      /does not carry a Sega cartridge header/,
    );
  });
});

describe('cartridge header', () => {
  it('parses the fixture header and confirms its checksum', () => {
    const rom = buildSyntheticRom({ serial: 'GM 00001009-00', region: 'JUE' });
    const header = readHeader(rom);

    assert.ok(looksLikeGenesisRom(rom));
    assert.equal(header.consoleName, 'SEGA MEGA DRIVE');
    assert.equal(header.serial, 'GM 00001009-00');
    assert.equal(header.region, 'JUE');
    assert.equal(header.checksumMatches, true);
    assert.equal(header.declaredChecksum, computeChecksum(rom));
  });

  it('reports a mismatch when a byte is altered after the checksum region starts', () => {
    const rom = buildSyntheticRom();
    rom[0x400] = (rom[0x400]! + 1) & 0xff;

    assert.equal(readHeader(rom).checksumMatches, false);
  });
});

describe('VDP decoding', () => {
  it('decodes CRAM words to the measured VDP output ladder', () => {
    assert.deepEqual(decodeCramColor(cramWord(7, 0, 0)), { r: 255, g: 0, b: 0, a: 255 });
    assert.deepEqual(decodeCramColor(cramWord(0, 7, 0)), { r: 0, g: 255, b: 0, a: 255 });
    assert.deepEqual(decodeCramColor(cramWord(0, 0, 7)), { r: 0, g: 0, b: 255, a: 255 });
    assert.deepEqual(decodeCramColor(0), { r: 0, g: 0, b: 0, a: 255 });
    assert.equal(decodeCramColor(cramWord(3, 0, 0)).r, 116);
  });

  it('splits a CRAM dump into four palette lines of sixteen colours', () => {
    const { cram } = buildSyntheticVdpState();
    const lines = decodeCram(cram);

    assert.equal(lines.length, 4);
    assert.equal(lines[0]!.length, 16);
    assert.deepEqual(lines[0]![1], { r: 255, g: 0, b: 0, a: 255 });
  });

  it('decodes a 4bpp tile with the left pixel in the high nibble', () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0x12;
    const tile = decodeTile(bytes);

    assert.equal(tile[0], 1);
    assert.equal(tile[1], 2);
    assert.equal(tile.length, 64);
  });

  it('derives plane and sprite-table addresses from VDP registers', () => {
    const { registers } = buildSyntheticVdpState();
    const addresses = planeAddresses(registers);

    assert.equal(addresses.planeA, 0xc000);
    assert.equal(addresses.planeB, 0xe000);
    assert.equal(addresses.spriteTable, 0xf000);
  });
});

describe('sprite attribute table', () => {
  it('walks the link list and stops at the terminator', () => {
    const { sat } = buildSyntheticVdpState();
    const sprites = parseSpriteTable(sat);

    assert.equal(sprites.length, 2);
    assert.deepEqual(
      sprites.map((s) => ({ x: s.x, y: s.y, w: s.widthCells, h: s.heightCells, tile: s.tileIndex })),
      [
        { x: 100, y: 50, w: 2, h: 2, tile: 1 },
        { x: 116, y: 50, w: 1, h: 2, tile: 5 },
      ],
    );
  });

  it('does not spin forever on a table whose links form a cycle', () => {
    const sat = new Uint8Array(80 * 8);
    writeSprite(sat, 0, { y: 0, x: 0, widthCells: 1, heightCells: 1, tileIndex: 1, link: 1 });
    writeSprite(sat, 1, { y: 0, x: 0, widthCells: 1, heightCells: 1, tileIndex: 2, link: 0 });
    // Point sprite 1 back at sprite 0 to create a cycle.
    sat[1 * 8 + 3] = 0;
    sat[1 * 8 + 3] = 1;

    const sprites = parseSpriteTable(sat);
    assert.ok(sprites.length <= 2);
  });

  it('honours the 80-sprite ceiling', () => {
    const sat = new Uint8Array(80 * 8);
    for (let i = 0; i < 80; i += 1) {
      writeSprite(sat, i, {
        y: i,
        x: i,
        widthCells: 1,
        heightCells: 1,
        tileIndex: 1,
        link: (i + 1) % 80,
      });
    }
    assert.ok(parseSpriteTable(sat, { maxSprites: 80 }).length <= 80);
  });
});

describe('runtime object reconstruction', () => {
  it('assembles adjacent hardware sprites into one object', () => {
    const { vram, cram, sat } = buildSyntheticVdpState();
    const objects = reconstructObjects({ vram, cram, sat });

    assert.equal(objects.length, 1);
    const object = objects[0]!;

    assert.equal(object.sprites.length, 2);
    assert.equal(object.x, 100);
    assert.equal(object.y, 50);
    // 2x2 cells plus an adjacent 1x2 column = 24x16 pixels.
    assert.equal(object.width, 24);
    assert.equal(object.height, 16);
  });

  it('places cells in column-major order within a sprite', () => {
    const { vram, cram, sat } = buildSyntheticVdpState();
    const object = reconstructObjects({ vram, cram, sat })[0]!;

    // Tiles were flooded with distinct indices: 1=red, 2=green, 3=blue.
    assert.deepEqual(pixelAt(object.image, 0, 0), { r: 255, g: 0, b: 0, a: 255 }); // tile 1
    assert.deepEqual(pixelAt(object.image, 0, 8), { r: 0, g: 255, b: 0, a: 255 }); // tile 2
    assert.deepEqual(pixelAt(object.image, 8, 0), { r: 0, g: 0, b: 255, a: 255 }); // tile 3
    assert.deepEqual(pixelAt(object.image, 8, 8), { r: 255, g: 0, b: 0, a: 255 }); // tile 4
    assert.deepEqual(pixelAt(object.image, 16, 0), { r: 0, g: 255, b: 0, a: 255 }); // tile 5
    assert.deepEqual(pixelAt(object.image, 16, 8), { r: 0, g: 0, b: 255, a: 255 }); // tile 6
  });

  it('mirrors cell order as well as pixels when a sprite is h-flipped', () => {
    const { vram, cram } = buildSyntheticVdpState();
    const sat = new Uint8Array(80 * 8);
    writeSprite(sat, 0, {
      y: 0,
      x: 0,
      widthCells: 2,
      heightCells: 1,
      tileIndex: 1,
      link: 0,
      hFlip: true,
    });

    // Unflipped this is [tile 1 (red)][tile 2 (green)]; flipped it must swap.
    const object = reconstructObjects({ vram, cram, sat })[0]!;
    assert.deepEqual(pixelAt(object.image, 0, 0), { r: 0, g: 255, b: 0, a: 255 });
    assert.deepEqual(pixelAt(object.image, 8, 0), { r: 255, g: 0, b: 0, a: 255 });
  });

  it('records the VRAM range each object was assembled from', () => {
    const { vram, cram, sat } = buildSyntheticVdpState();
    const object = reconstructObjects({ vram, cram, sat })[0]!;

    assert.equal(object.vramStart, 1 * 32);
    assert.equal(object.vramEnd, 7 * 32);
  });

  it('keeps distant sprites as separate objects', () => {
    const { vram, cram } = buildSyntheticVdpState();
    const sat = new Uint8Array(80 * 8);
    writeSprite(sat, 0, { y: 10, x: 10, widthCells: 1, heightCells: 1, tileIndex: 1, link: 1 });
    writeSprite(sat, 1, { y: 10, x: 200, widthCells: 1, heightCells: 1, tileIndex: 2, link: 0 });

    assert.equal(reconstructObjects({ vram, cram, sat }).length, 2);
  });

  it('groups by adjacency, not by sprite index', () => {
    const sprites = parseSpriteTable(buildSyntheticVdpState().sat);
    assert.equal(groupSprites(sprites).length, 1);
    assert.equal(groupSprites(sprites, -64).length, 2);
  });
});

describe('PNG output', () => {
  it('writes a signature-valid PNG of the right dimensions', () => {
    const image = createImage(24, 16);
    image.data.fill(0xff);
    const png = encodePng(image);

    assert.ok(isPng(png));

    // IHDR width and height are the first two big-endian words of the chunk data.
    const view = new DataView(png.buffer, png.byteOffset);
    assert.equal(view.getUint32(16), 24);
    assert.equal(view.getUint32(20), 16);
    assert.equal(png[24], 8); // bit depth
    assert.equal(png[25], 6); // RGBA
  });

  it('encodes a reconstructed object', () => {
    const { vram, cram, sat } = buildSyntheticVdpState();
    const object = reconstructObjects({ vram, cram, sat })[0]!;
    assert.ok(isPng(encodePng(object.image)));
  });
});

describe('static candidate discovery', () => {
  it('finds a planted palette and scores it', () => {
    const rom = buildSyntheticRom({ byteLength: 64 * 1024 });
    const planted = [
      cramWord(0, 0, 0), cramWord(7, 0, 0), cramWord(0, 7, 0), cramWord(0, 0, 7),
      cramWord(7, 7, 0), cramWord(7, 0, 7), cramWord(0, 7, 7), cramWord(7, 7, 7),
      cramWord(1, 2, 3), cramWord(3, 2, 1), cramWord(4, 5, 6), cramWord(6, 5, 4),
      cramWord(1, 1, 1), cramWord(2, 2, 2), cramWord(3, 3, 3), cramWord(4, 4, 4),
    ];
    planted.forEach((word, i) => {
      rom[0x8000 + i * 2] = (word >> 8) & 0xff;
      rom[0x8000 + i * 2 + 1] = word & 0xff;
    });

    const found = findPalettes(rom, { maxResults: 8 });
    assert.ok(found.some((c) => c.offset === 0x8000));
  });

  it('ranks a planted tile bank above random filler', () => {
    const rom = buildSyntheticRom({ byteLength: 128 * 1024 });
    const bankOffset = 0x10000;
    // Horizontal runs drawn from a small index set, which is what real 4bpp
    // art looks like: each tile row is a flat band of one colour.
    const bands = [0x00, 0x11, 0x22, 0x33, 0x44];
    for (let tile = 0; tile < 64; tile += 1) {
      for (let row = 0; row < 8; row += 1) {
        const band = bands[(tile + row) % bands.length]!;
        for (let b = 0; b < 4; b += 1) rom[bankOffset + tile * 32 + row * 4 + b] = band;
      }
    }

    const found = findTileBanks(rom, { tilesPerBank: 64, maxResults: 8 });
    assert.ok(found.some((c) => c.offset === bankOffset));
    assert.ok(found.every((c) => c.score >= 0 && c.score <= 1));
  });

  it('finds planted text', () => {
    const rom = buildSyntheticRom({ byteLength: 64 * 1024 });
    const text = 'ROUND ONE FIGHT';
    for (let i = 0; i < text.length; i += 1) rom[0x4000 + i] = text.charCodeAt(i);
    rom[0x4000 + text.length] = 0x00;

    assert.ok(findStrings(rom, { minLength: 6 }).some((s) => s.text.includes('ROUND ONE FIGHT')));
  });

  it('maps entropy across the image', () => {
    const rom = buildSyntheticRom({ byteLength: 64 * 1024 });
    const blocks = entropyMap(rom, 4096);

    assert.equal(blocks.length, 16);
    assert.ok(blocks.every((b) => b.entropy >= 0 && b.entropy <= 8));
    // The deterministic filler is high-entropy by construction.
    assert.ok(blocks[8]!.entropy > 7);
  });
});
