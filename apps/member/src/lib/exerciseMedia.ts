/**
 * #723 — the media an exercise of My Training Plan carries, as the Member app
 * sees it.
 *
 * The Member app renders the URLs `GET /me/training-plans` already returned and
 * decides nothing about where they came from: no System-sourced vs Custom, no
 * Base vs Gym exercise, no import, inheritance, synchronisation or fallback
 * resolution lives here (§"No Media Source Logic in Members"). That belongs to
 * the Exercises domain, which is why the API returns a single pair of URLs per
 * exercise.
 *
 * The optional `*_thumbnail_url` fields are not produced by any endpoint yet —
 * #719 adds the 512 × 512 image thumbnail and the stored video poster — so every
 * consumer here prefers a thumbnail when one arrives and falls back to the full
 * reference until then. Same contract as the Admin app's
 * `apps/admin/src/components/exerciseMedia.ts` (#720).
 */

export interface ExerciseMedia {
  exercise_name?: string | null;
  exercise_image_url?: string | null;
  exercise_image_thumbnail_url?: string | null;
  exercise_video_url?: string | null;
  exercise_video_thumbnail_url?: string | null;
}

/** The image to render in a card: the 512 × 512 thumbnail when it exists (#719). */
export function exerciseImageSrc(ex: ExerciseMedia): string | null {
  return ex.exercise_image_thumbnail_url || ex.exercise_image_url || null;
}

/** The image to render in the viewer: always the master, never the thumbnail. */
export function exerciseImageFullSrc(ex: ExerciseMedia): string | null {
  return ex.exercise_image_url || ex.exercise_image_thumbnail_url || null;
}

const YOUTUBE_ID = /^[\w-]{11}$/;

/** Video files a `<video>` element can play directly — anything else opens out. */
const PLAYABLE_FILE = /\.(mp4|m4v|mov|webm|ogv|ogg)$/i;

export type ExerciseVideoKind = 'youtube' | 'file' | 'external';

/**
 * How a video URL can be played inside My Training Plan.
 *
 * `exercises.video_url` is free text: in practice a YouTube link today, an
 * object in R2 once #719 lands, and potentially any other page in between. A
 * YouTube link plays in its own embed, an object plays in a `<video>` element,
 * and anything else is a page this app cannot embed — it opens in a new tab,
 * which leaves the member's Training Plan exactly where it was.
 */
export function exerciseVideoKind(url: string | null | undefined): ExerciseVideoKind | null {
  if (!url) return null;
  if (youtubeVideoId(url)) return 'youtube';
  try {
    return PLAYABLE_FILE.test(new URL(url.trim()).pathname) ? 'file' : 'external';
  } catch {
    return 'external';
  }
}

/**
 * A poster for a video URL without downloading the video itself.
 *
 * A YouTube link serves a still at a well-known address; anything else has no
 * poster derivable from the URL alone, so the card renders a play tile instead.
 * Either way no `<video>` is mounted to draw a card (§Performance) — the file
 * is only loaded once the member selects it.
 */
export function exerciseVideoPosterUrl(ex: ExerciseMedia): string | null {
  if (ex.exercise_video_thumbnail_url) return ex.exercise_video_thumbnail_url;
  const id = youtubeVideoId(ex.exercise_video_url ?? null);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

/** The embed address of a YouTube link, without autoplay (§Video). */
export function youtubeEmbedUrl(url: string | null | undefined): string | null {
  const id = youtubeVideoId(url ?? null);
  return id ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : null;
}

/** The YouTube id in a watch/share/embed URL, or null for any other URL. */
export function youtubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    return YOUTUBE_ID.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') return null;
  const v = parsed.searchParams.get('v');
  if (v && YOUTUBE_ID.test(v)) return v;
  const m = parsed.pathname.match(/^\/(?:embed|shorts|v|live)\/([\w-]{11})/);
  return m ? m[1] : null;
}

/** Whether an exercise has anything to render — no media means no container. */
export function hasExerciseMedia(ex: ExerciseMedia): boolean {
  return Boolean(exerciseImageSrc(ex) || ex.exercise_video_url);
}
