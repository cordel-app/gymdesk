import { describe, expect, it } from 'vitest';
import { exerciseBackgroundStyle } from '../lib/exerciseMedia';

// #1370 stage 3 — the row background is the effective image the API resolved.
describe('exerciseBackgroundStyle', () => {
  it('uses the thumbnail under an overlay', () => {
    const s = exerciseBackgroundStyle({ exercise_image_thumbnail_url: 'https://x/t.png', exercise_image_url: 'https://x/m.png' });
    expect(String(s.backgroundImage)).toContain('https://x/t.png');
    expect(String(s.backgroundImage)).toContain('linear-gradient');
  });
  it('falls back to the master when there is no thumbnail', () => {
    expect(String(exerciseBackgroundStyle({ exercise_image_url: 'https://x/m.png' }).backgroundImage)).toContain('https://x/m.png');
  });
  it('paints only the surface when there is no image', () => {
    expect(exerciseBackgroundStyle({}).backgroundImage).toBeUndefined();
  });
});
