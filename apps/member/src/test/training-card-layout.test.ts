import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1527 follow-up: image fills the card without an inner frame, and a single
// exercise uses the carousel's slide width, left-aligned. No component-test
// infra here, so the source is scanned (as nutrition-food-carousel.test.ts).
const SRC = join(__dirname, '..');
const carousel = readFileSync(join(SRC, 'components', 'BlockExerciseCarousel.tsx'), 'utf8');
const media = readFileSync(join(SRC, 'components', 'ExerciseMedia.tsx'), 'utf8');
const page = readFileSync(join(SRC, 'app', '[locale]', 'training', 'page.tsx'), 'utf8');

describe('My Training exercise card layout (#1527)', () => {
  it('single and multi cards share one slide width constant', () => {
    expect(carousel).toMatch(/const SLIDE_WIDTH = /);
    expect(carousel).toMatch(/single: \{ width: SLIDE_WIDTH/);
    expect(carousel).toMatch(/flex: `0 0 \$\{SLIDE_WIDTH\}`/);
  });
  it('the image fills the card with no inner frame', () => {
    expect(media).toMatch(/fill = false/);
    expect(media).toMatch(/tileFill:\s+\{ border: 'none', borderRadius: 0/);
    expect(page).toMatch(/<ExerciseMedia exercise=\{we\} fill \/>/);
    expect(page).toMatch(/exerciseCard: \{[^}]*padding: 0/);
  });
  it('the transparent padding of a non-square photo shows the image backdrop, not the card', () => {
    expect(media).toMatch(/aspectRatio: '1 \/ 1', lineHeight: 0, background: memberTheme\.exerciseImageBackdrop/);
  });
});
