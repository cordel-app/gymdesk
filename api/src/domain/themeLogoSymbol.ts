// #2157: a Theme's logo symbol — the symbol-only logo used as its favicon.
// Stored beside the full logo as `<theme folder>/logo/logo_symbol.webp`.

import sharp from 'sharp';
import { buildStorageObjectUrl } from '../infra/storage';
import { withImageProcessingSlot } from './imageProcessingSlot';
import { MEMBER_IMAGE_INPUT_FORMATS, MEMBER_IMAGE_MAX_PIXELS, type MemberImageRejection } from './memberImages';
import { buildThemeFolderPrefix, THEME_LOGO_FOLDER } from './themeFolders';

export const LOGO_SYMBOL_FILE = 'logo_symbol.webp';
export const LOGO_SYMBOL_MAX_WIDTH = 512;
const WEBP_QUALITY = 85;

/** The one key a theme's symbol is stored under; the extension is fixed (always WebP). */
export function buildThemeLogoSymbolKey(folderPrefix: string, themeId: string, themeName: string): string {
  return `${buildThemeFolderPrefix(folderPrefix, themeId, themeName)}/${THEME_LOGO_FOLDER}/${LOGO_SYMBOL_FILE}`;
}

/**
 * Server-side conversion: decoded-bytes format check, EXIF orientation, WebP with
 * the alpha channel kept, proportional resize to at most 512 px wide, never
 * upscaled, never cropped.
 */
export async function processLogoSymbol(
  input: Buffer,
): Promise<{ image: Buffer } | { rejection: MemberImageRejection }> {
  return withImageProcessingSlot(async () => {
    try {
      const meta = await sharp(input, { limitInputPixels: MEMBER_IMAGE_MAX_PIXELS, failOn: 'error' }).metadata();
      const format = meta.format as string | undefined;
      if (!format || !(MEMBER_IMAGE_INPUT_FORMATS as readonly string[]).includes(format)) {
        return { rejection: 'unsupported_format' as const };
      }
      if (!meta.width || !meta.height) return { rejection: 'unreadable' as const };
      const image = await sharp(input, { limitInputPixels: MEMBER_IMAGE_MAX_PIXELS, failOn: 'error' })
        .rotate()
        .resize({ width: LOGO_SYMBOL_MAX_WIDTH, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      return { image };
    } catch (err: any) {
      if (/pixel limit/i.test(String(err?.message))) return { rejection: 'too_many_pixels' as const };
      return { rejection: 'unreadable' as const };
    }
  });
}

/** Public URL of the symbol, cache-busted by the row's `modified_at` (the key is deterministic). */
export function themeLogoSymbolUrl(
  row: { logo_symbol_object_key?: string | null; modified_at?: Date | string | null },
): string | null {
  const url = buildStorageObjectUrl(row.logo_symbol_object_key);
  if (!url) return null;
  const at = row.modified_at ? new Date(row.modified_at).getTime() : NaN;
  return Number.isNaN(at) ? url : `${url}?v=${at}`;
}
