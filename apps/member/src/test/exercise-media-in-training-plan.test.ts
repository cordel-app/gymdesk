import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  exerciseImageFullSrc, exerciseImageSrc, exerciseVideoKind, exerciseVideoPosterUrl,
  hasExerciseMedia, youtubeEmbedUrl, youtubeVideoId,
} from '../lib/exerciseMedia';

// #723 — My Training Plan shows each exercise's image and video, at the
// exercise's own level of the existing hierarchy.
//
// The URL helpers are pure, so they are unit-tested directly. The rendering
// itself has no component-test infra in this repo (the Member app's
// dependencies are Next, next-intl, Clerk and FullCalendar — no
// testing-library, no jsdom), so — like nutrition-food-carousel.test.ts (#722)
// and apps/admin/src/test/exercise-media-thumbnails.test.ts (#720) — the
// components and their call site are pinned down by scanning their source.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const MEDIA = join(SRC, 'components', 'ExerciseMedia.tsx');
const VIEWER = join(SRC, 'components', 'ExerciseMediaViewer.tsx');
const HELPERS = join(SRC, 'lib', 'exerciseMedia.ts');
const TRAINING_PAGE = join(SRC, 'app', '[locale]', 'training', 'page.tsx');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Sources are scanned with their comments stripped — prose about a `<video>` is not one. */
const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));
const readRaw = (path: string) => readFileSync(path, 'utf-8');

describe('exercise media helpers (#723)', () => {
  it('prefers the 512 thumbnail in a row and the master in the viewer', () => {
    expect(exerciseImageSrc({ exercise_image_url: 'master.png' })).toBe('master.png');
    expect(exerciseImageSrc({
      exercise_image_url: 'master.png',
      exercise_image_thumbnail_url: 'thumb.png',
    })).toBe('thumb.png');
    expect(exerciseImageFullSrc({
      exercise_image_url: 'master.png',
      exercise_image_thumbnail_url: 'thumb.png',
    })).toBe('master.png');
    expect(exerciseImageFullSrc({ exercise_image_thumbnail_url: 'thumb.png' })).toBe('thumb.png');
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
    ['https://vimeo.com/76979871'],
    ['https://cdn.example.test/gyms/1-Gym/Exercises/Videos/squat.mp4'],
    ['not a url'],
    [''],
    [null],
  ])('returns no YouTube id for %s', (url) => {
    expect(youtubeVideoId(url as any)).toBeNull();
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://cdn.example.test/gyms/1-Gym/Exercises/Videos/squat.mp4', 'file'],
    ['https://cdn.example.test/videos/squat.webm', 'file'],
    ['https://cdn.example.test/videos/squat.MP4?v=2', 'file'],
    ['https://vimeo.com/76979871', 'external'],
    ['https://example.test/how-to-squat', 'external'],
  ])('classifies %s as a %s video', (url, kind) => {
    expect(exerciseVideoKind(url)).toBe(kind);
  });

  it('has no kind for an exercise with no video', () => {
    expect(exerciseVideoKind(null)).toBeNull();
    expect(exerciseVideoKind(undefined)).toBeNull();
    expect(exerciseVideoKind('')).toBeNull();
  });

  it('derives a poster without touching the video, and prefers a stored one (#719)', () => {
    expect(exerciseVideoPosterUrl({ exercise_video_url: 'https://youtu.be/dQw4w9WgXcQ' }))
      .toBe('https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
    expect(exerciseVideoPosterUrl({
      exercise_video_url: 'https://youtu.be/dQw4w9WgXcQ',
      exercise_video_thumbnail_url: 'poster.png',
    })).toBe('poster.png');
    // An .mp4 has no poster derivable from its URL — the card draws a play tile.
    expect(exerciseVideoPosterUrl({ exercise_video_url: 'https://cdn.example.test/squat.mp4' })).toBeNull();
  });

  it('embeds a YouTube video without autoplay', () => {
    const embed = youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(embed).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0');
    expect(embed).not.toContain('autoplay');
    expect(youtubeEmbedUrl('https://vimeo.com/76979871')).toBeNull();
  });

  it('reports no media for an exercise that carries none, so no container is rendered', () => {
    expect(hasExerciseMedia({})).toBe(false);
    expect(hasExerciseMedia({ exercise_image_url: null, exercise_video_url: null })).toBe(false);
    expect(hasExerciseMedia({ exercise_image_url: 'a.png' })).toBe(true);
    expect(hasExerciseMedia({ exercise_video_url: 'https://youtu.be/dQw4w9WgXcQ' })).toBe(true);
  });

  it('resolves no media source: no System/Custom, Base/Gym, import or inheritance logic', () => {
    const src = read(HELPERS);
    expect(src).not.toMatch(/cloned_from_id|system_sourced|is_custom|base_exercise|gym_id/i);
  });
});

describe('ExerciseMedia (#723 Image, Video, Performance)', () => {
  const src = read(MEDIA);

  it('renders nothing at all when the exercise has no media', () => {
    expect(src).toContain('if (!hasExerciseMedia(exercise)) return null;');
  });

  it('renders the URLs the API returned, resolving nothing about their source', () => {
    expect(src).toContain('exercise.exercise_video_url');
    expect(src).toContain('exerciseImageSrc(exercise)');
    expect(src).not.toMatch(/cloned_from_id|system_sourced|is_custom|base_exercise/i);
  });

  it('lazy-loads the thumbnails and never mounts a <video> to draw a row', () => {
    expect(src).toContain('loading="lazy"');
    expect(src).toContain('decoding="async"');
    expect(src).not.toMatch(/<video[\s>]/);
    expect(src).not.toMatch(/autoplay/i);
  });

  it('marks the video tile with a play indicator', () => {
    expect(src).toContain('exerciseVideoPosterUrl(exercise)');
    expect(src).toContain('styles.play');
    expect(src).toContain('▶');
  });

  it('opens the image and the video independently, each in its own viewer', () => {
    expect(src).toContain("setViewer('image')");
    expect(src).toContain("setViewer('video')");
    expect(src).toContain('<ExerciseImageViewer');
    expect(src).toContain('<ExerciseVideoViewer');
  });

  it('shows the image at full size in the viewer, not the row thumbnail', () => {
    expect(src).toContain('exerciseImageFullSrc(exercise)');
    expect(src).toContain('<ExerciseImageViewer src={fullSrc}');
  });

  it('hides a broken thumbnail without touching the other one', () => {
    expect(src).toContain('onError={() => setImageBroken(true)}');
    expect(src).toContain('onError={() => setPosterBroken(true)}');
  });

  it('gives both tiles accessible names built from the exercise name', () => {
    expect(src).toContain("t('exercise_media.view_image_of', { name })");
    expect(src).toContain("t('exercise_media.play_video_of', { name })");
    expect(src).toContain("t('exercise_media.image_alt', { name })");
  });

  it('keeps finger-sized touch targets', () => {
    expect(src).toContain('size = 52');
  });

  it('opens a video it cannot embed in a new tab, leaving the plan behind it', () => {
    expect(src).toContain("videoKind === 'external'");
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noreferrer"');
  });
});

describe('ExerciseImageViewer / ExerciseVideoViewer (#723 Image Viewer, Video Viewer)', () => {
  const src = read(VIEWER);

  it('is an overlay, so the member never leaves My Training Plan', () => {
    expect(src).toContain("position: 'fixed'");
    expect(src).not.toMatch(/useRouter|router\.(push|replace)/);
  });

  it('is a dialog with an obvious, labelled close action', () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain("aria-label={t('exercise_media.close')}");
  });

  it('closes on Escape and on a click outside the panel', () => {
    expect(src).toContain("event.key === 'Escape'");
    expect(src).toContain('if (event.target === event.currentTarget) onClose();');
  });

  it('moves focus to the close button and hands it back to the opener', () => {
    expect(src).toContain('closeRef.current?.focus();');
    expect(src).toContain('opener?.focus?.();');
  });

  it('preserves the image aspect ratio', () => {
    expect(src).toContain("objectFit: 'contain'");
  });

  it('plays the video with standard controls and never autoplays it', () => {
    expect(src).toContain('controls');
    expect(src).toContain('preload="metadata"');
    expect(src).not.toMatch(/\bautoPlay\b|autoplay=1/);
  });

  it('embeds a YouTube video through the shared helper', () => {
    expect(src).toContain('youtubeEmbedUrl(url)');
  });
});

describe('My Training Plan page (#723 Scope, Hierarchy, API)', () => {
  const src = read(TRAINING_PAGE);

  it('renders the media inside the exercise row, through the shared component', () => {
    expect(src).toContain("import { ExerciseMedia } from '@/components/ExerciseMedia';");
    expect(src).toContain('<ExerciseMedia exercise={we} />');
  });

  it('places it at the exercise level, not at workout or plan level', () => {
    const exerciseRow = src.indexOf('<ExerciseMedia');
    const blocksMap = src.indexOf('(workout.blocks ?? []).map');
    const exercisesMap = src.indexOf('(block.exercises ?? []).map');
    expect(exercisesMap).toBeGreaterThan(blocksMap);
    expect(exerciseRow).toBeGreaterThan(exercisesMap);
  });

  it('builds no media markup of its own', () => {
    expect(src).not.toMatch(/<img[\s>]/);
    expect(src).not.toMatch(/<video[\s>]/);
    expect(src).not.toMatch(/<iframe[\s>]/);
  });

  it('keeps the existing hierarchy, ordering and weekday navigation', () => {
    expect(src).toContain('(workout.blocks ?? []).map');
    expect(src).toContain('(block.exercises ?? []).map');
    expect(src).toContain('setSelectedWeekday');
    expect(src).toContain("t('training.mark_done')");
    expect(src).toContain('saveExerciseLog(we)');
  });

  it('adds no request per exercise — the media comes with the plan tree', () => {
    expect(src.match(/apiFetch</g)).toHaveLength(1);
    expect(src).toContain("'/me/training-plans'");
  });

  it('types the exercise media the plan tree returns', () => {
    expect(src).toContain('exercise_image_url?: string | null;');
    expect(src).toContain('exercise_video_url?: string | null;');
    expect(src).toContain('exercise_image_thumbnail_url?: string | null;');
    expect(src).toContain('exercise_video_thumbnail_url?: string | null;');
  });
});

describe('exercise media locales (#723)', () => {
  it.each(LOCALE_CODES)('%s defines the media labels', (code) => {
    const messages = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`)));
    const media = messages.exercise_media;
    for (const key of ['image', 'image_alt', 'view_image', 'view_image_of', 'play_video', 'play_video_of', 'video_of', 'close']) {
      expect(media?.[key], `${code}.json is missing exercise_media.${key}`).toBeTruthy();
    }
    expect(media.image_alt).toContain('{name}');
    expect(media.view_image_of).toContain('{name}');
    expect(media.play_video_of).toContain('{name}');
    expect(media.video_of).toContain('{name}');
  });
});
