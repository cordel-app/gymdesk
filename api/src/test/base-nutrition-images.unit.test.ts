// #715 — everything about a Base Nutrition Library image that needs no database
// and no bucket: the object key, the name sanitizer, the upload rules, the PNG
// reader/writer they are built on, and the offline illustration generator.
//
// Unit tests per CLAUDE.md: pure functions only, so no `createTestGym`, no
// `cleanupTestGyms` and no `db.end()`.

import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  BASE_NUTRITION_IMAGE_SIZE,
  PLATFORM_NUTRITION_PREFIX,
  baseNutritionFolderKeys,
  buildBaseNutritionImageKey,
  sanitizeNutritionImageName,
  validateBaseNutritionImage,
} from '../domain/baseNutritionImages';
import {
  PNG_COLOR_TYPE,
  encodePngRgba,
  isPng,
  pngSupportsTransparency,
  readPngMetadata,
} from '../domain/pngImage';
import { NUTRITION_ART_SIZE, renderNutritionImage } from '../domain/nutritionImageArt';

/** A PNG of `size²` fully transparent pixels — the shape an upload must have. */
function transparentPng(size = BASE_NUTRITION_IMAGE_SIZE): Buffer {
  return encodePngRgba(size, size, Buffer.alloc(size * size * 4));
}

/**
 * A header-only PNG with an arbitrary IHDR. The validator reads the IHDR and
 * stops, so this is enough to stand in for "an opaque truecolour PNG" or "a PNG
 * of the wrong size" without encoding pixels for it.
 */
function pngHeader(width: number, height: number, colorType: number): Buffer {
  const png = transparentPng(1);
  const copy = Buffer.from(png);
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  copy[25] = colorType;
  return copy;
}

/** Decodes a filter-0, colour-type-6 PNG back to its RGBA bytes. */
function decodeRgba(png: Buffer, size: number): Buffer {
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = size * 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    expect(raw[y * (stride + 1)]).toBe(0); // filter: None
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return rgba;
}

/** Fraction of the canvas the non-transparent pixels span, per axis. */
function subjectExtent(png: Buffer, size: number) {
  const rgba = decodeRgba(png, size);
  let minX = size; let maxX = -1; let minY = size; let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rgba[(y * size + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    width: (maxX - minX + 1) / size,
    height: (maxY - minY + 1) / size,
    centerX: (minX + maxX) / 2 / size,
    centerY: (minY + maxY) / 2 / size,
  };
}

describe('Base Nutrition Library image keys (#715 §1, §10, §11)', () => {
  it('stores every base food under cordel/Nutrition/', () => {
    expect(PLATFORM_NUTRITION_PREFIX).toBe('cordel/Nutrition');
    expect(buildBaseNutritionImageKey(123, 'Chicken Breast')).toBe('cordel/Nutrition/123-Chicken-Breast.png');
  });

  it('never uses a gym storage prefix', () => {
    const key = buildBaseNutritionImageKey(1, 'Apple');
    expect(key.startsWith('cordel/')).toBe(true);
    expect(key).not.toContain('gyms/');
  });

  it('includes the food id and ends in .png', () => {
    expect(buildBaseNutritionImageKey(456, 'Greek Yogurt')).toBe('cordel/Nutrition/456-Greek-Yogurt.png');
    expect(buildBaseNutritionImageKey(789, 'Brown Rice').endsWith('.png')).toBe(true);
  });

  it('sanitizes the food name exactly as §10 spells it', () => {
    expect(sanitizeNutritionImageName('Chicken Breast')).toBe('Chicken-Breast');
    expect(sanitizeNutritionImageName('Greek Yogurt')).toBe('Greek-Yogurt');
    expect(sanitizeNutritionImageName('Salmon, Atlantic')).toBe('Salmon-Atlantic');
  });

  it('is deterministic and produces no problematic characters', () => {
    const awkward = 'Jamón  ibérico / 50% — "cured"';
    expect(sanitizeNutritionImageName(awkward)).toBe(sanitizeNutritionImageName(awkward));
    expect(sanitizeNutritionImageName(awkward)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sanitizeNutritionImageName(awkward)).toBe('Jamon-iberico-50-cured');
  });

  it('falls back to `food` rather than producing an empty name', () => {
    expect(sanitizeNutritionImageName('!!!')).toBe('food');
    expect(buildBaseNutritionImageKey(7, '???')).toBe('cordel/Nutrition/7-food.png');
  });

  it('creates only the platform folder markers', () => {
    expect(baseNutritionFolderKeys()).toEqual(['cordel/', 'cordel/Nutrition/']);
  });
});

describe('Base Nutrition Library upload validation (#715 §2, §8)', () => {
  it('accepts a 512×512 PNG with an alpha channel', () => {
    expect(validateBaseNutritionImage(transparentPng())).toBeNull();
  });

  it('rejects anything that is not a PNG', () => {
    expect(validateBaseNutritionImage(Buffer.from('<html>not a png</html>'))).toBe('not_a_png');
    expect(validateBaseNutritionImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]))).toBe('not_a_png');
  });

  it('rejects a PNG of the wrong dimensions', () => {
    expect(validateBaseNutritionImage(transparentPng(256))).toBe('not_square_512');
    expect(validateBaseNutritionImage(pngHeader(512, 256, PNG_COLOR_TYPE.truecolorAlpha))).toBe('not_square_512');
  });

  it('rejects an opaque PNG — a transparent background is required', () => {
    expect(validateBaseNutritionImage(pngHeader(512, 512, PNG_COLOR_TYPE.truecolor))).toBe('not_transparent');
  });

  it('refuses a string or an array where bytes were expected', () => {
    expect(validateBaseNutritionImage('89504e470d0a1a0a')).toBe('not_a_png');
    expect(validateBaseNutritionImage([0x89, 0x50, 0x4e, 0x47])).toBe('not_a_png');
    expect(isPng('anything')).toBe(false);
  });
});

describe('PNG reader/writer', () => {
  it('round-trips an RGBA image', () => {
    const rgba = Buffer.alloc(2 * 2 * 4, 0x7f);
    const png = encodePngRgba(2, 2, rgba);
    const metadata = readPngMetadata(png);
    expect(metadata).toMatchObject({ width: 2, height: 2, bitDepth: 8, colorType: PNG_COLOR_TYPE.truecolorAlpha });
    expect(decodeRgba(png, 2).equals(rgba)).toBe(true);
  });

  it('refuses an RGBA buffer that does not match the dimensions', () => {
    expect(() => encodePngRgba(2, 2, Buffer.alloc(4))).toThrow(/must be 16 bytes/);
  });

  it('reads no metadata from a truncated file', () => {
    expect(readPngMetadata(transparentPng(1).subarray(0, 20))).toBeNull();
  });

  it('treats an alpha channel and a tRNS chunk as transparency, and nothing else', () => {
    expect(pngSupportsTransparency({
      width: 1, height: 1, bitDepth: 8, colorType: PNG_COLOR_TYPE.truecolor,
      hasAlphaChannel: false, hasTransparencyChunk: true,
    })).toBe(true);
    expect(pngSupportsTransparency({
      width: 1, height: 1, bitDepth: 8, colorType: PNG_COLOR_TYPE.indexed,
      hasAlphaChannel: false, hasTransparencyChunk: false,
    })).toBe(false);
  });
});

describe('Generated Base Nutrition Library artwork (#715 §2, §3)', () => {
  const foods = [
    { name: 'Chicken Breast', categories: ['main_dish'], qualities: ['protein'] },
    { name: 'Apple', categories: ['other'], qualities: ['fiber'] },
    { name: 'Brown Rice', categories: ['side'], qualities: ['carbohydrate'] },
    { name: 'Chocolate Cake', categories: ['dessert'], qualities: ['fat'] },
    { name: 'Orange Juice', categories: ['drink'], qualities: [] },
    { name: 'Tomato Sauce', categories: ['sauce'], qualities: [] },
  ];

  it('produces a 512×512 PNG with an alpha channel for every food', () => {
    for (const food of foods) {
      const png = renderNutritionImage(food);
      expect(validateBaseNutritionImage(png)).toBeNull();
      expect(readPngMetadata(png)).toMatchObject({
        width: NUTRITION_ART_SIZE,
        height: NUTRITION_ART_SIZE,
        colorType: PNG_COLOR_TYPE.truecolorAlpha,
      });
    }
  });

  it('leaves the background genuinely transparent', () => {
    const rgba = decodeRgba(renderNutritionImage(foods[0]), NUTRITION_ART_SIZE);
    const corners = [0, NUTRITION_ART_SIZE - 1, (NUTRITION_ART_SIZE - 1) * NUTRITION_ART_SIZE, NUTRITION_ART_SIZE * NUTRITION_ART_SIZE - 1];
    for (const pixel of corners) expect(rgba[pixel * 4 + 3]).toBe(0);
    // …and the middle of the canvas is not.
    const center = (NUTRITION_ART_SIZE / 2) * NUTRITION_ART_SIZE + NUTRITION_ART_SIZE / 2;
    expect(rgba[center * 4 + 3]).toBe(255);
  });

  it('centers the subject and fills 70–85% of the canvas, whatever the food', () => {
    for (const food of foods) {
      const extent = subjectExtent(renderNutritionImage(food), NUTRITION_ART_SIZE);
      const widest = Math.max(extent.width, extent.height);
      expect(widest).toBeGreaterThanOrEqual(0.7);
      expect(widest).toBeLessThanOrEqual(0.85);
      expect(Math.abs(extent.centerX - 0.5)).toBeLessThan(0.02);
      expect(Math.abs(extent.centerY - 0.5)).toBeLessThan(0.02);
    }
  });

  it('is deterministic — the same food always renders the same bytes', () => {
    const first = renderNutritionImage(foods[1]);
    const second = renderNutritionImage(foods[1]);
    expect(first.equals(second)).toBe(true);
  });

  it('distinguishes one food from another', () => {
    expect(renderNutritionImage(foods[0]).equals(renderNutritionImage(foods[1]))).toBe(false);
  });

  it('renders a food with no category or quality at all', () => {
    expect(validateBaseNutritionImage(renderNutritionImage({ name: 'Unclassified Food' }))).toBeNull();
  });
});
