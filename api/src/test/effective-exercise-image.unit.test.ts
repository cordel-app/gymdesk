import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveImage,
  withEffectiveImage,
  effectiveImageUrlSql,
  effectiveImageThumbnailUrlSql,
} from '../domain/effectiveExerciseImage';

const m = (id: number, name: string, url: string | null, thumb: string | null = null) =>
  ({ id, name, image_url: url, image_thumbnail_url: thumb });

describe('resolveEffectiveImage()', () => {
  it("prefers the exercise's own image and its own thumbnail", () => {
    expect(resolveEffectiveImage({ image_url: 'own', image_thumbnail_url: 'own-t' }, [m(1, 'Chest', 'c', 'c-t')]))
      .toEqual({ effective_image_url: 'own', effective_image_thumbnail_url: 'own-t' });
  });

  it('falls back to the alphabetically first primary muscle image, case-folded, id as tie-break', () => {
    const muscles = [m(3, 'quads', 'q', 'q-t'), m(2, 'Back', 'b', 'b-t'), m(1, 'back', 'b2', 'b2-t')];
    expect(resolveEffectiveImage({ image_url: null }, muscles))
      .toEqual({ effective_image_url: 'b2', effective_image_thumbnail_url: 'b2-t' });
  });

  it('accepts the JSON string MySQL returns and ignores muscles without an image', () => {
    const json = JSON.stringify([m(1, 'Abs', null), m(2, 'Biceps', 'bi', null)]);
    expect(resolveEffectiveImage({}, json)).toEqual({ effective_image_url: 'bi', effective_image_thumbnail_url: null });
  });

  it('is null when there is nothing to show', () => {
    expect(resolveEffectiveImage({ image_url: null }, null)).toEqual({ effective_image_url: null, effective_image_thumbnail_url: null });
    expect(resolveEffectiveImage({ image_url: null }, 'not json')).toEqual({ effective_image_url: null, effective_image_thumbnail_url: null });
  });
});

describe('withEffectiveImage()', () => {
  it('keeps the raw fields and drops the helper column', () => {
    const out = withEffectiveImage({ id: 1, image_url: null, image_thumbnail_url: null, primary_muscle_images: [m(1, 'Abs', 'a', 'a-t')] });
    expect(out).toMatchObject({ id: 1, image_url: null, effective_image_url: 'a', effective_image_thumbnail_url: 'a-t' });
    expect('primary_muscle_images' in out).toBe(false);
  });
});

describe('SQL spelling', () => {
  it('uses the same ordering and role as the resolver', () => {
    for (const sql of [effectiveImageUrlSql('e'), effectiveImageThumbnailUrlSql('e')]) {
      expect(sql).toContain("pem.role = 'principal'");
      expect(sql).toContain('ORDER BY LOWER(pm.name), pm.id LIMIT 1');
    }
  });
});
