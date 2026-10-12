import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveImage,
  withEffectiveImage,
  effectiveImageUrlSql,
  effectiveImageThumbnailUrlSql,
  effectiveVideoUrlSql,
  effectiveVideoPosterSql,
} from '../domain/effectiveExerciseImage';

const m = (id: number, name: string, url: string | null, thumb: string | null = null) =>
  ({ id, name, image_url: url, image_thumbnail_url: thumb });

const NONE = { effective_image_url: null, effective_image_thumbnail_url: null };

describe('resolveEffectiveImage()', () => {
  it("prefers the exercise's own male image, with its derived thumbnail (#1420)", () => {
    expect(resolveEffectiveImage(
      { image_male_url: 'https://cdn/1-Press-male.webp', image_female_url: 'https://cdn/1-Press-female.webp' },
      [m(1, 'Chest', 'c', 'c-t')],
    )).toEqual({
      effective_image_url: 'https://cdn/1-Press-male.webp',
      effective_image_thumbnail_url: 'https://cdn/1-Press-male-thumbnail.webp',
    });
  });

  it('uses the female image when there is no male one (no sex context)', () => {
    expect(resolveEffectiveImage({ image_male_url: null, image_female_url: 'https://cdn/1-Press-female.webp' }, null))
      .toEqual({
        effective_image_url: 'https://cdn/1-Press-female.webp',
        effective_image_thumbnail_url: 'https://cdn/1-Press-female-thumbnail.webp',
      });
  });

  it('has no thumbnail for an own image that is not one of ours', () => {
    expect(resolveEffectiveImage({ image_male_url: 'https://elsewhere/pic.png' }, null))
      .toEqual({ effective_image_url: 'https://elsewhere/pic.png', effective_image_thumbnail_url: null });
  });

  it('falls back to the alphabetically first primary muscle image, case-folded, id as tie-break', () => {
    const muscles = [m(3, 'quads', 'q', 'q-t'), m(2, 'Back', 'b', 'b-t'), m(1, 'back', 'b2', 'b2-t')];
    expect(resolveEffectiveImage({ image_male_url: null, image_female_url: null }, muscles))
      .toEqual({ effective_image_url: 'b2', effective_image_thumbnail_url: 'b2-t' });
  });

  it('accepts the JSON string MySQL returns and ignores muscles without an image', () => {
    const json = JSON.stringify([m(1, 'Abs', null), m(2, 'Biceps', 'bi', null)]);
    expect(resolveEffectiveImage({}, json)).toEqual({ effective_image_url: 'bi', effective_image_thumbnail_url: null });
  });

  it('is null when there is nothing to show', () => {
    expect(resolveEffectiveImage({ image_male_url: null }, null)).toEqual(NONE);
    expect(resolveEffectiveImage({ image_male_url: null }, 'not json')).toEqual(NONE);
  });
});

describe('withEffectiveImage()', () => {
  it('keeps the raw fields and drops the helper column', () => {
    const out = withEffectiveImage({
      id: 1, image_male_url: null, image_female_url: null, primary_muscle_images: [m(1, 'Abs', 'a', 'a-t')],
    });
    expect(out).toMatchObject({ id: 1, image_male_url: null, effective_image_url: 'a', effective_image_thumbnail_url: 'a-t' });
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

  it('takes the own male image, then the female one, then the muscle (#1420)', () => {
    expect(effectiveImageUrlSql('e')).toMatch(/^COALESCE\(e\.image_male_url, e\.image_female_url, /);
    expect(effectiveImageThumbnailUrlSql('e')).toContain('COALESCE(e.image_male_url, e.image_female_url) IS NULL');
  });

  it('derives the thumbnails from the master URL instead of reading a column', () => {
    expect(effectiveImageThumbnailUrlSql('e')).toContain("'-thumbnail.webp'");
    expect(effectiveVideoPosterSql('e')).toContain("'-thumbnail.webp'");
    expect(effectiveVideoPosterSql('e')).toContain("LIKE '%.mp4'");
    expect(effectiveVideoUrlSql('e')).toBe('COALESCE(e.video_male_url, e.video_female_url)');
  });

  it('names no legacy column', () => {
    for (const sql of [
      effectiveImageUrlSql('e'), effectiveImageThumbnailUrlSql('e'), effectiveVideoUrlSql('e'), effectiveVideoPosterSql('e'),
    ]) {
      expect(sql).not.toMatch(/e\.(image|video)_(thumbnail_)?url\b/);
    }
  });
});
