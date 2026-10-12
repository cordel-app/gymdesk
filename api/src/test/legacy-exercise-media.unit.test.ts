// #1420 (last stage): the legacy exercise media columns are gone, the objects
// behind them are purged by key, and nothing reads or writes them again.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  exerciseMediaFolders,
  isLegacyExerciseMediaKey,
} from '../domain/legacyExerciseMediaPurge';

describe('isLegacyExerciseMediaKey', () => {
  it.each([
    'gyms/g1-Fit/exercises/images/7-Press.png',
    'gyms/g1-Fit/exercises/images/7-Press-thumbnail.png',
    'gyms/g1-Fit/exercises/videos/7-Press.mp4',
    'gyms/g1-Fit/exercises/videos/7-Press-thumbnail.png',
    'gyms/g1-Fit/exercises/images/0b6c1f0e-0000-4000-8000-000000000000.png',
    'cordel/exercises/images/3-Squat.png',
  ])('is legacy: %s', (key) => {
    expect(isLegacyExerciseMediaKey(key, false)).toBe(true);
  });

  it.each([
    'gyms/g1-Fit/exercises/images/7-Press-male.webp',
    'gyms/g1-Fit/exercises/images/7-Press-female-thumbnail.webp',
    'gyms/g1-Fit/exercises/videos/7-Press-male.mp4',
    'gyms/g1-Fit/exercises/videos/7-Press-female.webp',
    'gyms/g1-Fit/exercises/videos/7-Press-male-thumbnail.webp',
    'cordel/exercises/images/3-Squat-female.webp',
  ])('is not legacy: %s', (key) => {
    expect(isLegacyExerciseMediaKey(key, false)).toBe(false);
  });

  it('never treats a folder marker as an object', () => {
    expect(isLegacyExerciseMediaKey('gyms/g1-Fit/exercises/images/', false)).toBe(false);
    expect(isLegacyExerciseMediaKey('gyms/g1-Fit/Exercises/Images/', true)).toBe(false);
    expect(isLegacyExerciseMediaKey('', false)).toBe(false);
  });

  it('treats everything in the pre-#1035 capitalised folders as legacy', () => {
    expect(isLegacyExerciseMediaKey('gyms/g1-Fit/Exercises/Images/7-Press.png', true)).toBe(true);
    expect(isLegacyExerciseMediaKey('cordel/Exercises/Videos/3-Squat.mp4', true)).toBe(true);
  });
});

describe('exerciseMediaFolders', () => {
  it('scans only the exercise media folders of a root', () => {
    expect(exerciseMediaFolders('gyms/g1-Fit')).toEqual([
      { folder: 'gyms/g1-Fit/exercises/images/', legacyCase: false },
      { folder: 'gyms/g1-Fit/exercises/videos/', legacyCase: false },
      { folder: 'gyms/g1-Fit/Exercises/Images/', legacyCase: true },
      { folder: 'gyms/g1-Fit/Exercises/Videos/', legacyCase: true },
    ]);
  });
});

// The retired columns may not come back in a query: an exercise row (`e.`, or an
// `UPDATE exercises SET …`) answers ER_BAD_FIELD_ERROR, which is a bare 500.
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'test' || entry === 'migrations' || entry === 'node_modules') continue;
      sources(path, out);
    } else if (/\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('no production source reads or writes a legacy exercise media column', () => {
  const files = sources(join(__dirname, '..'));

  it('does not select e.image_url / e.video_url (or their thumbnails) from exercises', () => {
    const offenders = files.filter((file) =>
      /\be\.(?:image|video)_(?:thumbnail_)?url\b/.test(stripComments(readFileSync(file, 'utf-8'))));
    expect(offenders).toEqual([]);
  });

  it('does not update or insert them on exercises', () => {
    const pattern = /UPDATE exercises SET[^`'"]*\b(?:image|video)_(?:thumbnail_)?url\b/s;
    const insert = /INSERT INTO exercises[^`'"]*\b(?:image|video)_(?:thumbnail_)?url\b/s;
    const offenders = files.filter((file) => {
      const src = stripComments(readFileSync(file, 'utf-8'));
      return pattern.test(src) || insert.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
