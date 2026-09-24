/**
 * #720 — media an exercise carries, as the workout UI sees it.
 *
 * The workout layer knows nothing about where a URL came from (System vs gym
 * object, imported or uploaded): it renders whatever `exercise_image_url` /
 * `exercise_video_url` the API returned. The optional `*_thumbnail_url` fields
 * are not produced by any endpoint yet — #719 adds the 2048/512 master +
 * thumbnail model and the video poster — so every consumer here prefers a
 * thumbnail when one arrives and falls back to the full reference until then.
 */
export interface ExerciseMedia {
  exercise_name?: string;
  exercise_image_url?: string | null;
  exercise_image_thumbnail_url?: string | null;
  exercise_video_url?: string | null;
  exercise_video_thumbnail_url?: string | null;
}

/** The image to render in a row: the 512 × 512 thumbnail when it exists (#719). */
export function exerciseImageSrc(ex: ExerciseMedia): string | null {
  return ex.exercise_image_thumbnail_url || ex.exercise_image_url || null;
}

const YOUTUBE_ID = /^[\w-]{11}$/;

/**
 * A poster for a video URL without downloading the video itself.
 *
 * `exercises.video_url` is a free-text URL and is in practice a YouTube link,
 * which serves a still at a well-known address. Anything else (an .mp4 in R2,
 * a Vimeo page) has no poster that can be derived from the URL alone, so the
 * row renders a play tile instead — never a `<video>`, which would pull the
 * file into every workout row (§3, §10).
 */
export function exerciseVideoPosterUrl(ex: ExerciseMedia): string | null {
  if (ex.exercise_video_thumbnail_url) return ex.exercise_video_thumbnail_url;
  const id = youtubeVideoId(ex.exercise_video_url ?? null);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

/** The YouTube id in a watch/share/embed URL, or null for any other URL. */
export function youtubeVideoId(url: string | null): string | null {
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

/** Whether a row has anything to render at all — no media means no container (§4). */
export function hasExerciseMedia(ex: ExerciseMedia): boolean {
  return Boolean(exerciseImageSrc(ex) || ex.exercise_video_url);
}
