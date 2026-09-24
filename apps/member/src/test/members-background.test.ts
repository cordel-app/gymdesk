import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BACKGROUND_SCRIM_ALPHA,
  MEMBER_BACKGROUND_SLOTS,
  backgroundStyleValue,
  backgroundUrlForSlot,
  hexToRgba,
  slotForPathname,
} from '../lib/membersBackground';

// #725 — the Members App renders the background artwork its theme configures.
//
// The pure helpers are tested directly; the component and the layout are
// scanned, since apps/member has no component-test infra (same approach as
// exercise-media-in-training-plan.test.ts (#723) and
// nutrition-food-carousel.test.ts (#722)).

const COMPONENT_PATH = join(__dirname, '..', 'components', 'MembersBackground.tsx');
const LAYOUT_PATH = join(__dirname, '..', 'app', '[locale]', 'layout.tsx');
const LIB_PATH = join(__dirname, '..', 'lib', 'membersBackground.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(readFileSync(COMPONENT_PATH, 'utf-8'));
const layoutSrc = stripComments(readFileSync(LAYOUT_PATH, 'utf-8'));
const libSrc = stripComments(readFileSync(LIB_PATH, 'utf-8'));

describe('which background a page uses (#725)', () => {
  it('knows the six slots', () => {
    expect([...MEMBER_BACKGROUND_SLOTS]).toEqual(
      ['training', 'nutrition', 'calendar', 'bookings', 'membership', 'background'],
    );
  });

  it('maps each Members section to its own slot', () => {
    expect(slotForPathname('/en/training')).toBe('training');
    expect(slotForPathname('/en/nutrition')).toBe('nutrition');
    expect(slotForPathname('/en/calendar')).toBe('calendar');
    // "My Bookings" is the `/schedule` route.
    expect(slotForPathname('/es/schedule')).toBe('bookings');
    expect(slotForPathname('/ca/membership')).toBe('membership');
  });

  it('keeps the slot for a nested route of a section', () => {
    expect(slotForPathname('/en/training/2026-09-24')).toBe('training');
  });

  it('falls back to the general background for everything else', () => {
    for (const path of ['/en', '/en/', '/en/profile', '/en/notifications', '/en/packages', '/en/payment/success']) {
      expect(slotForPathname(path)).toBe('background');
    }
    expect(slotForPathname(null)).toBe('background');
  });
});

describe('resolving a slot to a URL (#725 §No Fallback Logic)', () => {
  it('returns the configured URL', () => {
    expect(backgroundUrlForSlot({ training_url: 'https://r2/training.png' }, 'training'))
      .toBe('https://r2/training.png');
  });

  it('returns null for an unconfigured slot, and resolves nothing else', () => {
    expect(backgroundUrlForSlot({ training_url: 'https://r2/training.png' }, 'calendar')).toBeNull();
    expect(backgroundUrlForSlot({ training_url: null }, 'training')).toBeNull();
    expect(backgroundUrlForSlot(null, 'training')).toBeNull();
    expect(backgroundUrlForSlot(undefined, 'background')).toBeNull();
  });

  it('never substitutes the general background for a missing section image', () => {
    expect(backgroundUrlForSlot({ background_url: 'https://r2/background.png' }, 'training')).toBeNull();
  });
});

describe('painting it (#725 §Members App Rendering)', () => {
  it('covers, centres and does not repeat — so nothing is distorted', () => {
    const value = backgroundStyleValue('https://r2/training.png', null)!;
    expect(value).toContain('center center / cover no-repeat');
    expect(value).toContain('url("https://r2/training.png")');
    expect(value).not.toContain('100% 100%');
  });

  it('quotes the URL, so one with a space or a parenthesis cannot break the rule', () => {
    const value = backgroundStyleValue('https://r2/my background (1).png', null)!;
    expect(value).toContain('url("https://r2/my background (1).png")');
  });

  it('lays the theme\'s own colour over the image as the readability scrim', () => {
    const scrim = hexToRgba('#101828', BACKGROUND_SCRIM_ALPHA)!;
    expect(scrim).toBe('rgba(16, 24, 40, 0.72)');
    const value = backgroundStyleValue('https://r2/training.png', scrim)!;
    expect(value.startsWith(`linear-gradient(${scrim}, ${scrim}), `)).toBe(true);
  });

  it('accepts a three-digit hex and rejects anything that is not a hex colour', () => {
    expect(hexToRgba('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(hexToRgba('rebeccapurple', 0.5)).toBeNull();
    expect(hexToRgba('', 0.5)).toBeNull();
    expect(hexToRgba(null, 0.5)).toBeNull();
    // A theme with no usable colour still gets its artwork, just no scrim.
    expect(backgroundStyleValue('https://r2/a.png', hexToRgba('nope', 0.5))).toContain('url(');
  });

  it('paints nothing at all for an unconfigured slot', () => {
    expect(backgroundStyleValue(null, 'rgba(0, 0, 0, 0.5)')).toBeNull();
  });
});

describe('the Members App knows only URLs (#725 §Members App Rendering)', () => {
  it('mounts next to the theme provider and renders no markup of its own', () => {
    expect(layoutSrc).toContain('<MembersBackground />');
    expect(componentSrc).toContain('return null;');
  });

  it('reads the URLs straight off the theme payload — no request of its own', () => {
    expect(componentSrc).toContain('theme?.members_images');
    expect(componentSrc).not.toContain('fetch(');
    expect(componentSrc).not.toContain('apiFetch');
  });

  it('builds no storage path and holds no upload or removal logic', () => {
    for (const src of [componentSrc, libSrc]) {
      expect(src).not.toContain('object_key');
      expect(src).not.toContain('storage_folder_prefix');
      expect(src).not.toContain('/Themes/');
      expect(src).not.toMatch(/\bupload\b/i);
      expect(src).not.toMatch(/\br2\.cloudflarestorage\b/i);
    }
  });

  it('clears the background back to the theme colour when nothing is configured', () => {
    expect(componentSrc).toContain("body.style.removeProperty('background')");
  });
});
