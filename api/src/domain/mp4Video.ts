// Reading an MP4's own boxes, with no dependency beyond node (#719 part 2).
//
// #719 §7 requires the server to validate an uploaded video *and not rely on the
// browser-provided MIME type* — which is the client's word, exactly like the
// file name. The alternative to parsing would be `ffprobe` in the API image, and
// the answer on #719 Q2 rules that out along with `sharp`/`ffmpeg`. So this
// module reads what an ISO base media file says about itself:
//
//  - the `ftyp` **brand**, which is what separates a real MP4 from a QuickTime
//    `.mov` renamed to `.mp4`;
//  - the `moov` header, whose absence means the file is truncated or is not an
//    ISO base media file at all;
//  - the **sample entry formats** in every `stsd`, which name the codecs — the
//    only place in the container that says "there is an H.264 video track here".
//
// Pure, allocation-light and header-only: boxes are walked by their declared
// sizes, so a 50 MB upload is read as a handful of jumps rather than a scan, and
// the `mdat` payload is never touched. Same split as `pngImage.ts` (#715): the
// bytes are understood here, and the *rules* about them live in
// `exerciseVideos.ts`.

/** Bytes a box header occupies: 4-byte size + 4-byte type. */
const HEADER_BYTES = 8;

/** Guards against a malformed file turning the walk into a long loop. */
const MAX_BOXES = 4096;
const MAX_DEPTH = 8;

/**
 * Boxes that contain other boxes on the path from `moov` to a sample
 * description. Anything not listed is skipped whole — including `mdat`, which is
 * the video itself and must never be descended into.
 */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/**
 * Brands that mean "MP4 family". `isom` and the `mp4x`/`iso*` family are the
 * ones a browser, ffmpeg or a phone camera writes; `qt  ` (QuickTime) is
 * deliberately absent, so a `.mov` renamed to `.mp4` is refused rather than
 * stored under a key that claims it is an MP4.
 *
 * The check is satisfied by the major brand *or* any compatible brand, which is
 * how the container declares "readable as": a file whose major brand is `avc1`
 * or `dash` almost always lists `isom` alongside it.
 */
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso8', 'iso9',
  'mp41', 'mp42', 'mmp4', 'avc1', 'dash', 'cmfc', 'M4V ', 'M4VP', 'mp71',
]);

/**
 * Sample entry formats that are a *video* track, mapped to the codec name a
 * rejection can quote. H.264 (`avc1`/`avc3`) is what #719 §7 prefers; the rest
 * are containers a browser can still play, so they are recognised rather than
 * reported as "no video track at all" — `exerciseVideos.ts` decides which of
 * them an upload may use.
 */
export const VIDEO_SAMPLE_ENTRIES: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'HEVC',
  hev1: 'HEVC',
  av01: 'AV1',
  vp09: 'VP9',
  mp4v: 'MPEG-4 Visual',
};

export interface Mp4Metadata {
  /** `ftyp`'s major brand, e.g. `isom`. */
  majorBrand: string;
  /** The brands the file also declares itself readable as. */
  compatibleBrands: string[];
  /** True when a `moov` box was found — no movie header, no playable file. */
  hasMovieBox: boolean;
  /** Sample entry formats found in every `stsd`, in the order encountered. */
  sampleEntries: string[];
  /** The subset of {@link sampleEntries} that names a video codec. */
  videoSampleEntries: string[];
}

function readBoxSize(bytes: Buffer, offset: number, limit: number): number | null {
  const declared = bytes.readUInt32BE(offset);
  if (declared === 1) {
    // 64-bit `largesize` follows the type. Read as a JS number: a real file is
    // orders of magnitude below 2^53, and anything larger is refused below.
    if (offset + 16 > limit) return null;
    const high = bytes.readUInt32BE(offset + 8);
    const low = bytes.readUInt32BE(offset + 12);
    const size = high * 0x100000000 + low;
    return size >= 16 ? size : null;
  }
  // 0 means "to the end of the file" — legal for the last box only.
  if (declared === 0) return limit - offset;
  return declared >= HEADER_BYTES ? declared : null;
}

/** Where a box's payload starts, relative to the box itself. */
function payloadOffset(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset) === 1 ? 16 : HEADER_BYTES;
}

function boxType(bytes: Buffer, offset: number): string {
  return bytes.subarray(offset + 4, offset + 8).toString('latin1');
}

/** Four-character codes in a buffer, e.g. `ftyp`'s compatible brand list. */
function readBrands(payload: Buffer, from: number): string[] {
  const brands: string[] = [];
  for (let at = from; at + 4 <= payload.length; at += 4) {
    brands.push(payload.subarray(at, at + 4).toString('latin1'));
  }
  return brands;
}

/**
 * Sample entry formats in one `stsd` payload: a full box (1 version byte + 3
 * flag bytes), an entry count, then that many sized boxes whose type *is* the
 * four-character codec name (`avc1`, `mp4a`, …).
 */
function readSampleEntries(payload: Buffer): string[] {
  if (payload.length < 8) return [];
  const count = payload.readUInt32BE(4);
  const entries: string[] = [];
  let at = 8;
  for (let i = 0; i < count && at + HEADER_BYTES <= payload.length; i += 1) {
    const size = payload.readUInt32BE(at);
    entries.push(payload.subarray(at + 4, at + 8).toString('latin1'));
    if (size < HEADER_BYTES) break;
    at += size;
  }
  return entries;
}

/**
 * What an MP4 says about itself, or null when the bytes are not an ISO base
 * media file at all (no readable `ftyp`).
 *
 * A malformed size ends the walk instead of throwing — a truncated upload is
 * "not a readable MP4", which is a 400, not a 500 — and `mdat` is skipped by its
 * declared size, so the video payload is never read.
 */
export function readMp4Metadata(body: unknown): Mp4Metadata | null {
  // A string and an array both carry a `length` and numeric indices, so either
  // would walk as if it were bytes (CodeQL
  // `js/type-confusion-through-parameter-tampering`) — the same guard
  // `isPng()` applies.
  if (typeof body === 'string' || Array.isArray(body) || !Buffer.isBuffer(body)) return null;
  const bytes = body;
  if (bytes.length < HEADER_BYTES + 8) return null;
  if (boxType(bytes, 0) !== 'ftyp') return null;

  const ftypSize = readBoxSize(bytes, 0, bytes.length);
  if (ftypSize === null || ftypSize < 16 || ftypSize > bytes.length) return null;
  const ftyp = bytes.subarray(payloadOffset(bytes, 0), ftypSize);
  if (ftyp.length < 8) return null;

  const metadata: Mp4Metadata = {
    majorBrand: ftyp.subarray(0, 4).toString('latin1'),
    // 4 brand bytes + 4 minor-version bytes, then the compatible brands.
    compatibleBrands: readBrands(ftyp, 8),
    hasMovieBox: false,
    sampleEntries: [],
    videoSampleEntries: [],
  };

  let boxes = 0;
  const walk = (from: number, to: number, depth: number): void => {
    let offset = from;
    while (offset + HEADER_BYTES <= to) {
      if ((boxes += 1) > MAX_BOXES) return;
      const size = readBoxSize(bytes, offset, to);
      if (size === null || size < HEADER_BYTES || offset + size > to) return;
      const type = boxType(bytes, offset);
      const start = offset + payloadOffset(bytes, offset);
      if (type === 'moov') metadata.hasMovieBox = true;
      if (type === 'stsd') {
        // 4 bytes of version/flags, which `readSampleEntries()` steps over.
        for (const entry of readSampleEntries(bytes.subarray(start, offset + size))) {
          metadata.sampleEntries.push(entry);
          if (VIDEO_SAMPLE_ENTRIES[entry]) metadata.videoSampleEntries.push(entry);
        }
      } else if (CONTAINER_BOXES.has(type) && depth < MAX_DEPTH) {
        walk(start, offset + size, depth + 1);
      }
      offset += size;
    }
  };
  walk(0, bytes.length, 0);

  return metadata;
}

/** Whether the file's brands put it in the MP4 family (a `.mov` does not). */
export function isMp4Brand(metadata: Mp4Metadata): boolean {
  return [metadata.majorBrand, ...metadata.compatibleBrands].some((brand) => MP4_BRANDS.has(brand));
}

/** The codec names of the file's video tracks, e.g. `['H.264']`. */
export function videoCodecNames(metadata: Mp4Metadata): string[] {
  const names = metadata.videoSampleEntries.map((entry) => VIDEO_SAMPLE_ENTRIES[entry]).filter(Boolean);
  return [...new Set(names)];
}
