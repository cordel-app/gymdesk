// Preparing gender-specific exercise media for `POST
// /exercises/:id/(image|video)/:gender` (#1420 stage 3).
//
// An exercise has four independent references — a male and a female image and a
// male and a female video. The **server** makes every WebP file (stage 2): the
// browser sends the picture it picked as it is, and so this module does no
// cropping, resizing or encoding of its own. What it does is what only a browser
// can: check the file before a multi-megabyte upload, and — because `sharp`
// cannot decode MP4 — capture the one frame a video upload carries.
//
// The server repeats every check from the files' own bytes, so nothing here is a
// security boundary. The rule it must get right is the one the server cannot
// enforce: **if the frame cannot be captured, the upload does not happen at all**,
// so the video already on the exercise is never replaced by one with no preview.

import { blobToBase64 } from './exerciseImageUpload';
import { decodeFirstFrame, exerciseVideoMaxMb } from './exerciseVideoUpload';

export const EXERCISE_GENDERS = ['male', 'female'] as const;
export type ExerciseGender = (typeof EXERCISE_GENDERS)[number];

export const EXERCISE_MEDIA_KINDS = ['image', 'video'] as const;
export type ExerciseMediaKind = (typeof EXERCISE_MEDIA_KINDS)[number];

/** `image_male`, `image_female`, `video_male`, `video_female` — one control each. */
export type GenderMediaKey = `${ExerciseMediaKind}_${ExerciseGender}`;

export const GENDER_MEDIA_KEYS: GenderMediaKey[] = [
  'image_male',
  'image_female',
  'video_male',
  'video_female',
];

export const genderMediaKey = (kind: ExerciseMediaKind, gender: ExerciseGender): GenderMediaKey =>
  `${kind}_${gender}`;

/** The route a control acts on: `<basePath>/<id>/<kind>/<gender>`. */
export function genderMediaPath(
  basePath: string,
  exerciseId: number | string,
  kind: ExerciseMediaKind,
  gender: ExerciseGender,
): string {
  return `${basePath}/${exerciseId}/${kind}/${gender}`;
}

/** What the API reports of an exercise's gendered media (`withGenderMediaCompanions()`). */
export interface ExerciseGenderMediaValues {
  image_male_url?: string | null;
  image_female_url?: string | null;
  video_male_url?: string | null;
  video_female_url?: string | null;
  image_male_thumbnail_url?: string | null;
  image_female_thumbnail_url?: string | null;
  video_male_preview_url?: string | null;
  video_male_preview_thumbnail_url?: string | null;
  video_female_preview_url?: string | null;
  video_female_preview_thumbnail_url?: string | null;
}

/** The stored master reference of one control. */
export function genderMediaMaster(values: ExerciseGenderMediaValues | null | undefined, key: GenderMediaKey): string | null {
  return (values?.[`${key}_url` as keyof ExerciseGenderMediaValues] as string | null | undefined) ?? null;
}

/** The small WebP a control draws: an image's thumbnail or a video's preview thumbnail. */
export function genderMediaThumbnail(values: ExerciseGenderMediaValues | null | undefined, key: GenderMediaKey): string | null {
  if (!values) return null;
  const field = key.startsWith('image_') ? `${key}_thumbnail_url` : `${key}_preview_thumbnail_url`;
  return (values[field as keyof ExerciseGenderMediaValues] as string | null | undefined) ?? null;
}

// ─── Limits ───────────────────────────────────────────────────────────────────

/** The formats the server decodes (`EXERCISE_IMAGE_INPUT_FORMATS`). */
export const EXERCISE_IMAGE_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** What `NEXT_PUBLIC_EXERCISE_IMAGE_MAX_MB` defaults to — the API's own default. */
export const EXERCISE_IMAGE_DEFAULT_MAX_MB = 10;
const EXERCISE_IMAGE_CEILING_MAX_MB = 25;

/** Mirrors the API's `EXERCISE_IMAGE_MAX_MB` so the picker refuses an oversized file early. */
export function exerciseGenderImageMaxMb(): number {
  const configured = Number(process.env.NEXT_PUBLIC_EXERCISE_IMAGE_MAX_MB);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, EXERCISE_IMAGE_CEILING_MAX_MB)
    : EXERCISE_IMAGE_DEFAULT_MAX_MB;
}

/** The longest side of the frame sent with a video: the server fits it into 1080 anyway. */
export const VIDEO_FRAME_MAX_SIDE = 1920;

export type GenderMediaProblem = 'not_an_image' | 'not_an_mp4' | 'too_large' | 'unreadable' | 'frame_failed';

/** One upload's request body plus the small preview a staged pick shows. */
export interface PreparedGenderMedia {
  kind: ExerciseMediaKind;
  /** The JSON body of the `POST`: `{ image }` or `{ video, frame }`, base64, byte for byte. */
  body: { image: string } | { video: string; frame: string };
  /** A `data:image/…` URL drawn for a staged pick — never an object URL minted from the file. */
  preview: string;
}

export function isPreparedGenderMedia(result: PreparedGenderMedia | GenderMediaProblem): result is PreparedGenderMedia {
  return typeof result !== 'string';
}

// ─── Images ───────────────────────────────────────────────────────────────────

/**
 * The `{ image }` body for a picked picture, or the reason there isn't one. The
 * picture is sent untouched: orientation, containment, padding, WebP and the
 * thumbnail are the server's.
 */
export async function prepareGenderImage(file: File): Promise<PreparedGenderMedia | GenderMediaProblem> {
  if (!(EXERCISE_IMAGE_INPUT_TYPES as readonly string[]).includes(file.type)) return 'not_an_image';
  if (file.size > exerciseGenderImageMaxMb() * 1024 * 1024) return 'too_large';
  if (file.size === 0) return 'unreadable';
  const image = await blobToBase64(file);
  return { kind: 'image', body: { image }, preview: `data:${file.type};base64,${image}` };
}

// ─── Videos ───────────────────────────────────────────────────────────────────

/**
 * Draws one frame of `file` at its own aspect ratio into a PNG, its longest side
 * at most {@link VIDEO_FRAME_MAX_SIDE}. Unlike the legacy poster this is **not**
 * cover-cropped: the server contains the frame and pads it, so cropping here would
 * lose what the server is required to keep. Null whenever no frame can be drawn.
 */
export async function captureVideoFrame(file: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const video = await decodeFirstFrame(url);
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const scale = Math.min(1, VIDEO_FRAME_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The `{ video, frame }` body for a picked MP4, or the reason there isn't one.
 * Every failure mode returns a problem rather than a partial body, so a failed
 * capture can never replace the video already on the exercise.
 */
export async function prepareGenderVideo(file: File): Promise<PreparedGenderMedia | GenderMediaProblem> {
  if (file.type !== 'video/mp4' && !file.name.toLowerCase().endsWith('.mp4')) return 'not_an_mp4';
  if (file.size > exerciseVideoMaxMb() * 1024 * 1024) return 'too_large';
  const frame = await captureVideoFrame(file);
  if (!frame) return file.size === 0 ? 'unreadable' : 'frame_failed';
  const [video, frameBase64] = await Promise.all([blobToBase64(file), blobToBase64(frame)]);
  return { kind: 'video', body: { video, frame: frameBase64 }, preview: `data:image/png;base64,${frameBase64}` };
}

// ─── Staged uploads ───────────────────────────────────────────────────────────

/** What a creation card holds until the exercise has an id to upload to. */
export type StagedGenderMedia = Partial<Record<GenderMediaKey, PreparedGenderMedia>>;

/**
 * Posts every staged pick to the exercise that now exists, one at a time (each is
 * a large body and the server decodes at most two at once). Returns the keys that
 * failed with the server's message, so the caller can report them without failing
 * the exercise's creation.
 */
export async function uploadStagedGenderMedia(
  post: (path: string, body: unknown) => Promise<unknown>,
  basePath: string,
  exerciseId: number | string,
  staged: StagedGenderMedia,
): Promise<{ key: GenderMediaKey; message: string | null }[]> {
  const failures: { key: GenderMediaKey; message: string | null }[] = [];
  for (const key of GENDER_MEDIA_KEYS) {
    const prepared = staged[key];
    if (!prepared) continue;
    const [kind, gender] = key.split('_') as [ExerciseMediaKind, ExerciseGender];
    try {
      await post(genderMediaPath(basePath, exerciseId, kind, gender), prepared.body);
    } catch (err: any) {
      failures.push({ key, message: err?.message ?? null });
    }
  }
  return failures;
}
