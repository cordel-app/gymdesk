import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  exerciseImageSrc, exerciseVideoPosterUrl, hasExerciseMedia, youtubeVideoId,
} from '../components/exerciseMedia';

// #720 — every workout view shows the media the exercise already carries, on
// the right of the exercise row, through one shared component.
//
// The URL helpers are pure, so they are unit-tested directly. The rendering
// itself has no component-test infra in this repo (see docs/architecture.md's
// TL;DR), so — like workout-block-config.test.ts (#672) — the component and its
// four call sites are pinned down by scanning their source.

const SRC = join(__dirname, '..');
const APP_DIR = join(SRC, 'app', '[locale]');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const COMPONENT = join(SRC, 'components', 'ExerciseMediaThumbnails.tsx');

// Every admin view that renders an exercise inside a workout (§6).
const WORKOUT_VIEWS = {
  'Workouts / Training Plan builder': join(APP_DIR, 'workout-templates', 'WorkoutBlockBuilder.tsx'),
  'Workout Templates tree': join(APP_DIR, 'workout-templates', 'WorkoutTemplateTree.tsx'),
  'Training Plan Templates tree': join(APP_DIR, 'training-plan-templates', 'TrainingPlanTree.tsx'),
  'member Training Plan block exercises': join(APP_DIR, 'members', 'PlanBlockExercisesModal.tsx'),
} as const;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Sources are scanned with their comments stripped — prose about a `<video>` is not one. */
const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));
const readRaw = (path: string) => readFileSync(path, 'utf-8');

describe('exercise media helpers (#720)', () => {
  it('prefers the 512 thumbnail over the master image once #719 supplies one', () => {
    expect(exerciseImageSrc({ exercise_image_url: 'master.png' })).toBe('master.png');
    expect(exerciseImageSrc({
      exercise_image_url: 'master.png',
      exercise_image_thumbnail_url: 'thumb.png',
    })).toBe('thumb.png');
    expect(exerciseImageSrc({ exercise_image_url: null })).toBeNull();
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('reads the YouTube id out of %s', (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it.each([
    'https://cdn.example.test/gyms/1-Gym/Exercises/Videos/press.mp4',
    'https://vimeo.com/123456789',
    'not a url',
    '',
  ])('has no YouTube id for %s', (url) => {
    expect(youtubeVideoId(url)).toBeNull();
  });

  it('builds a poster from a YouTube URL instead of loading the video', () => {
    expect(exerciseVideoPosterUrl({ exercise_video_url: 'https://youtu.be/dQw4w9WgXcQ' }))
      .toBe('https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  });

  it('has no poster for a video URL it cannot derive one from — the row falls back to a play tile', () => {
    expect(exerciseVideoPosterUrl({ exercise_video_url: 'https://cdn.example.test/press.mp4' })).toBeNull();
  });

  it('uses the API-supplied video thumbnail when there is one (#719)', () => {
    expect(exerciseVideoPosterUrl({
      exercise_video_url: 'https://youtu.be/dQw4w9WgXcQ',
      exercise_video_thumbnail_url: 'poster.png',
    })).toBe('poster.png');
  });

  it('reports no media when the exercise has neither URL, so nothing is rendered', () => {
    expect(hasExerciseMedia({ exercise_image_url: null, exercise_video_url: null })).toBe(false);
    expect(hasExerciseMedia({ exercise_image_url: 'i.png', exercise_video_url: null })).toBe(true);
    expect(hasExerciseMedia({ exercise_image_url: null, exercise_video_url: 'v.mp4' })).toBe(true);
  });
});

describe('ExerciseMediaThumbnails (#720)', () => {
  const src = read(COMPONENT);

  it('renders nothing at all when the exercise has no media', () => {
    expect(src).toContain('if (!hasExerciseMedia(exercise)) return null;');
  });

  it('never mounts a <video>, so the MP4 is not downloaded to draw a row', () => {
    expect(src).not.toMatch(/<video[\s>]/);
  });

  it('lazy-loads both thumbnails', () => {
    expect(src.match(/loading="lazy"/g)).toHaveLength(2);
  });

  it('marks the video tile with a play indicator', () => {
    expect(src).toContain('▶');
  });

  it('hides a thumbnail that fails to load without touching the other one', () => {
    expect(src).toContain('onError={() => setImageBroken(true)}');
    expect(src).toContain('onError={() => setPosterBroken(true)}');
  });

  it('carries no source/ownership/import logic (§8)', () => {
    expect(src).not.toMatch(/\bsystem\b|\bcustom\b|base_?exercise|imported/i);
  });
});

describe('workout views (#720)', () => {
  it.each(Object.entries(WORKOUT_VIEWS))('%s renders the shared component', (_name, path) => {
    const src = read(path);
    expect(src).toContain("import { ExerciseMediaThumbnails } from '@/components/ExerciseMediaThumbnails';");
    expect(src).toContain('<ExerciseMediaThumbnails exercise=');
  });

  it.each(Object.entries(WORKOUT_VIEWS))('%s does not build its own media markup', (_name, path) => {
    const src = read(path);
    // No hand-rolled thumbnail, no poster derivation, and above all no <video>
    // element in a workout row — that all lives in the shared component.
    expect(src).not.toMatch(/<video[\s>]/);
    expect(src).not.toContain('img.youtube.com');
    expect(src).not.toContain('▶');
  });

  it('types the media on the shared tree exercise shape', () => {
    const summaries = read(join(APP_DIR, 'workout-templates', 'summaries.ts'));
    expect(summaries).toContain('exercise_image_url: string | null; exercise_video_url: string | null;');
  });
});

describe('exercise media locales (#720)', () => {
  it.each(LOCALE_CODES)('%s defines the accessible labels', (code) => {
    const messages = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`)));
    expect(Object.keys(messages.exercise_media).sort())
      .toEqual(['image', 'image_alt', 'play_video', 'play_video_of']);
    expect(messages.exercise_media.image_alt).toContain('{name}');
    expect(messages.exercise_media.play_video_of).toContain('{name}');
  });
});
