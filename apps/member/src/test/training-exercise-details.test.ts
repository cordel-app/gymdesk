import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1527 follow-up: the whole card opens the details; play and Register are independent.
const SRC = join(__dirname, '..');
const page = readFileSync(join(SRC, 'app', '[locale]', 'training', 'page.tsx'), 'utf8');
const media = readFileSync(join(SRC, 'components', 'ExerciseMedia.tsx'), 'utf8');

describe('My Training exercise card details and video (#1527)', () => {
  it('the card opens the details modal', () => {
    expect(page).toMatch(/onClick=\{\(\) => setDetailsExercise\(we\)\}/);
    expect(page).toMatch(/<ExerciseDetailsDialog/);
  });
  it('play and Register do not bubble to the card', () => {
    expect(page).toMatch(/e\.stopPropagation\(\); setVideoExercise\(we\)/);
    expect(page).toMatch(/e\.stopPropagation\(\); openExercise\(we\)/);
  });
  it('the play button is rendered only when a video exists', () => {
    expect(page).toMatch(/we\.exercise_video_url && exerciseVideoKind/);
  });
  it('a card image is plain, not a button or video tile', () => {
    expect(media).toMatch(/if \(fill\) \{\s+if \(!thumbSrc\) return null;/);
  });
});
