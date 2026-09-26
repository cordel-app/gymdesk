// Synthetic MP4s for the #719 part 2 tests.
//
// `POST /exercises/:id/video` validates a file from its own boxes, so the tests
// need real ISO base media files rather than a blob with an `.mp4` name — and a
// checked-in sample video would be megabytes of binary in the repository for
// something the parser reads the first few hundred bytes of. These builders
// produce exactly the boxes `domain/mp4Video.ts` looks at: `ftyp` (the brand),
// `moov → trak → mdia → minf → stbl → stsd` (the codec), and an `mdat` of
// whatever size a test needs to stand in for the payload.
//
// Not a `.test.ts` file: vitest only collects those, so this is imported, never
// run on its own.

/** One box: 4-byte size, 4-byte type, payload. */
export function mp4Box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/** `ftyp`: major brand, minor version, then the compatible brands. */
export function ftypBox(majorBrand: string, compatibleBrands: string[]): Buffer {
  const minorVersion = Buffer.alloc(4);
  return mp4Box(
    'ftyp',
    Buffer.from(majorBrand, 'latin1'),
    minorVersion,
    Buffer.concat(compatibleBrands.map((brand) => Buffer.from(brand, 'latin1'))),
  );
}

/**
 * `stsd` with one sample entry of `format` — `avc1` for H.264 video, `mp4a` for
 * an audio track. The entry's own payload is not read by anything here, so it is
 * the fixed 78 bytes a real visual sample entry starts with, zero-filled.
 */
export function stsdBox(format: string): Buffer {
  const versionAndFlags = Buffer.alloc(4);
  const entryCount = Buffer.alloc(4);
  entryCount.writeUInt32BE(1, 0);
  return mp4Box('stsd', versionAndFlags, entryCount, mp4Box(format, Buffer.alloc(78)));
}

export interface Mp4FixtureOptions {
  /** `ftyp`'s major brand. `qt  ` is how a QuickTime `.mov` identifies itself. */
  majorBrand?: string;
  compatibleBrands?: string[];
  /** Sample entry formats, one track each. `[]` builds a file with no `stsd`. */
  codecs?: string[];
  /** False builds a file with no movie header — a truncated upload. */
  withMovieBox?: boolean;
  /** Bytes of `mdat` payload, to make a fixture of a given size. */
  mdatBytes?: number;
}

/** A minimal but structurally real MP4. Defaults to one H.264 video track. */
export function buildMp4(options: Mp4FixtureOptions = {}): Buffer {
  const {
    majorBrand = 'isom',
    compatibleBrands = ['isom', 'mp42', 'avc1'],
    codecs = ['avc1'],
    withMovieBox = true,
    mdatBytes = 0,
  } = options;

  const parts: Buffer[] = [ftypBox(majorBrand, compatibleBrands)];
  if (mdatBytes > 0) parts.push(mp4Box('mdat', Buffer.alloc(mdatBytes, 0x21)));
  if (withMovieBox) {
    const traks = codecs.map((codec) => mp4Box('trak', mp4Box('mdia', mp4Box('minf', mp4Box('stbl', stsdBox(codec))))));
    parts.push(mp4Box('moov', ...(traks.length > 0 ? traks : [mp4Box('mvhd', Buffer.alloc(100))])));
  }
  return Buffer.concat(parts);
}

/** The same file, base64-encoded, as an upload body carries it. */
export function buildMp4Base64(options: Mp4FixtureOptions = {}): string {
  return buildMp4(options).toString('base64');
}
