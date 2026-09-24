// The offline illustration generator behind the Base Nutrition Library backfill
// (#715 §3).
//
// ## What this is, and what it is not
//
// It renders a **512×512 transparent PNG of a stylized food form**: one centered
// subject filling ~78% of the canvas, flat-shaded with a vertical gradient, a
// soft specular highlight and a darker rim, over full transparency. Every image
// comes out of the same renderer, so the library gets exactly the consistent
// scale, lighting and level of detail §2 asks for, with no text, label, logo,
// scenery or background anywhere in it.
//
// It is **not** a photoreal depiction of each specific food, and it does not
// claim to be. Producing one would need an image-generation model, and `CLAUDE.md`
// forbids an AI/LLM integration in this product — the ticket's own answer on the
// thread says the same ("do not add an AI/image-generation integration to the
// production API"). So the shape family comes from the food's *category* and its
// dominant nutritional *quality*, and the palette from the food's name, which
// makes each food's image stable, distinguishable and plausibly coloured
// (`Apple` red, `Brown Rice` beige) without pretending to be a photograph.
//
// The backfill script therefore prefers real artwork whenever it is given any:
// `--from <dir>` uploads files named after the food, and the `Upload Image`
// button replaces any single image later. This renderer is what guarantees that
// *no base food is left without an image*, which is the acceptance criterion.
//
// Pure and dependency-free: same input, same bytes, no network, no filesystem.

import { encodePngRgba } from './pngImage';

/** The canvas §2 fixes: 512×512, square. */
export const NUTRITION_ART_SIZE = 512;

/**
 * Half-extent of the subject's *bounding box* as a fraction of the canvas: 0.405
 * → the form spans at most 81% of the canvas along its widest axis, and — since
 * a lobe's peak can land anywhere around the silhouette — at least 73%. Both
 * ends sit inside §2's "approximately 70–85%" whatever the food is called.
 *
 * It is the bounding box rather than the base radius because both the lobe
 * modulation and the squash stretch the silhouette past a plain circle — a
 * droplet squashed to 1.28 would otherwise reach 95% of the canvas vertically.
 * {@link subjectRadius} divides the two back out, so every shape family fills
 * the same share of the frame, which is what "consistent visual scale across the
 * library" means.
 */
const SUBJECT_HALF_EXTENT = 0.405;
const MODULATION = 0.05;

/**
 * The base radius that makes a shape's widest half-extent land exactly on
 * {@link SUBJECT_HALF_EXTENT}. `squash` divides the vertical axis, so a value
 * below 1 stretches the form vertically and above 1 stretches it horizontally.
 */
function subjectRadius(size: number, squash: number): number {
  const widest = (1 + MODULATION) * Math.max(1, 1 / squash);
  return (SUBJECT_HALF_EXTENT * size) / widest;
}

/** 3×3 supersampling per pixel: enough to keep the silhouette's edge smooth. */
const SUPERSAMPLE = 3;

interface Rgb { r: number; g: number; b: number }

/**
 * A curated palette of food-plausible colours. The name's hash picks one, so a
 * food keeps its colour for ever, and the set is small enough that the library
 * reads as one family rather than a rainbow.
 */
const PALETTE: Rgb[] = [
  { r: 198, g: 60, b: 48 },   // tomato / red fruit
  { r: 226, g: 138, b: 47 },  // squash / citrus
  { r: 232, g: 190, b: 86 },  // cheese / grain
  { r: 122, g: 160, b: 64 },  // green vegetable
  { r: 86, g: 132, b: 96 },   // leafy green
  { r: 156, g: 105, b: 62 },  // roast / nut
  { r: 205, g: 160, b: 120 }, // poultry / bread
  { r: 224, g: 214, b: 196 }, // dairy / rice
  { r: 118, g: 86, b: 132 },  // berry / aubergine
  { r: 180, g: 96, b: 104 },  // salmon / cured meat
];

/**
 * Shape families. `lobes` is how many bulges the silhouette has and `squash`
 * how far it departs from a circle — together enough to read as "a piece of
 * fruit", "a fillet", "a wedge" or "a bowlful" while staying one visual
 * language. Keyed by the category slugs `nutrition_library_categories` seeds.
 */
const SHAPES: Record<string, { lobes: number; squash: number }> = {
  main_dish: { lobes: 2, squash: 0.82 }, // a fillet/portion: wider than tall
  side: { lobes: 5, squash: 1.0 },       // a heap of something
  sauce: { lobes: 1, squash: 1.18 },     // a droplet: taller than wide
  drink: { lobes: 0, squash: 1.28 },     // a tall vessel-ish column
  dessert: { lobes: 3, squash: 0.95 },   // a wedge/slice
  other: { lobes: 0, squash: 1.0 },      // a plain round form
};

const DEFAULT_SHAPE = SHAPES.other;

/**
 * FNV-1a over the food's name. A hash rather than the row id, so an image's
 * colour follows the *food* and stays the same if the library is ever reseeded
 * with different ids.
 */
function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function lighten(color: Rgb, t: number): Rgb {
  return mix(color, { r: 255, g: 255, b: 255 }, t);
}

function darken(color: Rgb, t: number): Rgb {
  return mix(color, { r: 40, g: 32, b: 28 }, t);
}

export interface NutritionArtInput {
  /** The food's base name — decides the palette and the silhouette's phase. */
  name: string;
  /** Category slugs of the food (`main_dish`, `side`, …); the first one wins. */
  categories?: string[];
  /**
   * Nutritional quality slugs (`protein`, `carbohydrate`, …). Only used to nudge
   * the palette towards the quality's own hue family, so a protein and a
   * carbohydrate of the same name family don't come out identical.
   */
  qualities?: string[];
  /** Canvas edge in pixels. Defaults to {@link NUTRITION_ART_SIZE}. */
  size?: number;
}

/** Which palette entry a quality nudges towards, when the food declares one. */
const QUALITY_BIAS: Record<string, number> = {
  protein: 9,
  carbohydrate: 7,
  fat: 2,
  fiber: 3,
};

/**
 * Renders one food as a 512×512 RGBA PNG with a transparent background.
 *
 * Deterministic: the same `name`/`categories`/`qualities` always produce
 * byte-identical output, which is what lets the backfill be re-run without
 * churning objects in the bucket.
 */
export function renderNutritionImage(input: NutritionArtInput): Buffer {
  const size = input.size ?? NUTRITION_ART_SIZE;
  const name = (input.name ?? '').trim();
  const hash = hashName(name.toLowerCase());

  const shape = SHAPES[input.categories?.[0] ?? ''] ?? DEFAULT_SHAPE;
  const qualityBias = QUALITY_BIAS[input.qualities?.[0] ?? ''];
  const baseIndex = hash % PALETTE.length;
  // A declared quality pulls the colour halfway towards its family's hue, so the
  // name still distinguishes two proteins from each other.
  const base = qualityBias === undefined
    ? PALETTE[baseIndex]
    : mix(PALETTE[baseIndex], PALETTE[qualityBias % PALETTE.length], 0.5);

  const top = lighten(base, 0.22);
  const bottom = darken(base, 0.3);
  const rim = darken(base, 0.45);
  // Phase from the hash so two foods of the same category aren't the same
  // silhouette, and a tilt so nothing looks mechanically axis-aligned.
  const phase = ((hash >>> 8) % 360) * (Math.PI / 180);
  const tilt = (((hash >>> 16) % 21) - 10) * (Math.PI / 180);

  const rgba = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = subjectRadius(size, shape.squash);
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      // `depth` is the average distance-from-edge of the covered samples, which
      // is what the rim shading below reads.
      let depthSum = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) * step - 0.5;
          const py = y + (sy + 0.5) * step - 0.5;
          let dx = px - cx;
          let dy = py - cy;
          // Rotate into the subject's own frame, then squash it.
          const rx = dx * Math.cos(tilt) + dy * Math.sin(tilt);
          const ry = -dx * Math.sin(tilt) + dy * Math.cos(tilt);
          dx = rx;
          dy = ry * shape.squash;
          const dist = Math.hypot(dx, dy);
          if (dist === 0) { covered += 1; depthSum += 1; continue; }
          const theta = Math.atan2(dy, dx);
          const edge = radius * (1 + MODULATION * Math.sin(shape.lobes * theta + phase));
          if (dist <= edge) {
            covered += 1;
            depthSum += 1 - dist / edge;
          }
        }
      }
      const offset = (y * size + x) * 4;
      if (covered === 0) {
        // Transparent background: all four bytes stay zero.
        continue;
      }
      const depth = depthSum / covered;
      // Vertical gradient, lit from the top.
      const gradient = Math.min(1, Math.max(0, (y - (cy - radius)) / (2 * radius)));
      let color = mix(top, bottom, gradient);
      // A soft specular highlight up and to the left, and a darker rim.
      const hx = (x - (cx - radius * 0.34)) / (radius * 0.6);
      const hy = (y - (cy - radius * 0.38)) / (radius * 0.6);
      const highlight = Math.max(0, 1 - Math.hypot(hx, hy));
      color = lighten(color, 0.38 * highlight * highlight);
      if (depth < 0.12) color = mix(color, rim, (0.12 - depth) / 0.12);

      rgba[offset] = color.r;
      rgba[offset + 1] = color.g;
      rgba[offset + 2] = color.b;
      rgba[offset + 3] = Math.round((covered / samples) * 255);
    }
  }

  return encodePngRgba(size, size, rgba);
}
