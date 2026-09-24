import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BACKGROUND_SCRIM_ALPHA,
  CARD_SCRIM_ALPHA,
  backgroundStyleValue,
  backgroundUrlForSlot,
  cardBackgroundStyleValue,
  hexToRgba,
} from '../lib/membersBackground';

// #728 — the six Members App theme images are the backgrounds of the Members
// home sections: Calendar, My Training Plan, My Bookings, My Nutrition and My
// Membership each take their own, over the general page background #725
// already paints.
//
// The pure helpers are tested directly; the components and the page are
// scanned, since apps/member has no component-test infra (same approach as
// members-background.test.ts (#725) and nutrition-food-carousel.test.ts).

const CARD_PATH = join(__dirname, '..', 'components', 'MembersSectionCard.tsx');
const HOME_PATH = join(__dirname, '..', 'app', '[locale]', 'page.tsx');
const LIB_PATH = join(__dirname, '..', 'lib', 'membersBackground.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const cardSrc = stripComments(readFileSync(CARD_PATH, 'utf-8'));
const homeSrc = stripComments(readFileSync(HOME_PATH, 'utf-8'));
const libSrc = stripComments(readFileSync(LIB_PATH, 'utf-8'));

describe('the home sections map to their own images (#728 §Home Page Mapping)', () => {
  const MAPPING: Array<[string, string]> = [
    ['nav.calendar', 'calendar'],
    ['nav.training', 'training'],
    ['nav.bookings', 'bookings'],
    ['nav.nutrition', 'nutrition'],
  ];

  for (const [label, slot] of MAPPING) {
    it(`${label} uses the ${slot} image`, () => {
      const tile = homeSrc.match(new RegExp(`<NavTile[^>]*t\\('${label}'\\)[^>]*>`))![0];
      expect(tile).toContain(`slot="${slot}"`);
    });
  }

  it('My Membership uses the membership image', () => {
    expect(homeSrc).toContain('<MembersSectionCard slot="membership"');
  });

  it('leaves the Next Booking card alone — it is not one of the six sections', () => {
    // The only surfaces that take artwork are the four tiles and My Membership.
    expect(homeSrc.match(/slot="/g)).toHaveLength(5);
  });

  it('keeps the general page background on #725\'s component rather than restating it here', () => {
    expect(homeSrc).not.toContain('slot="background"');
    expect(homeSrc).not.toContain('MembersBackground');
  });
});

describe('painting a card (#728 §Visual Treatment)', () => {
  it('covers and centres the artwork, so it keeps its aspect ratio', () => {
    const value = cardBackgroundStyleValue('https://r2/calendar.png', null)!;
    expect(value).toContain('url("https://r2/calendar.png")');
    expect(value).toContain('center center / cover no-repeat');
    expect(value).not.toContain('100% 100%');
  });

  it('scrolls with its card, unlike the page background, which is fixed', () => {
    expect(cardBackgroundStyleValue('https://r2/calendar.png', null)).toContain('no-repeat scroll');
    expect(backgroundStyleValue('https://r2/background.png', null)).toContain('no-repeat fixed');
  });

  it('lays the theme\'s own card colour over the image as the readability scrim', () => {
    const scrim = hexToRgba('#ffffff', CARD_SCRIM_ALPHA)!;
    expect(scrim).toBe('rgba(255, 255, 255, 0.82)');
    const value = cardBackgroundStyleValue('https://r2/calendar.png', scrim)!;
    expect(value.startsWith(`linear-gradient(${scrim}, ${scrim}), `)).toBe(true);
  });

  it('keeps the artwork visible — the scrim never fully covers it', () => {
    expect(CARD_SCRIM_ALPHA).toBeGreaterThan(BACKGROUND_SCRIM_ALPHA);
    expect(CARD_SCRIM_ALPHA).toBeLessThan(1);
  });

  it('paints nothing for a slot the theme does not configure', () => {
    expect(cardBackgroundStyleValue(null, 'rgba(0, 0, 0, 0.5)')).toBeNull();
    expect(backgroundUrlForSlot({ calendar_url: null }, 'calendar')).toBeNull();
  });
});

describe('the section card is a background, not a redesign (#728 §Preserve Existing UI)', () => {
  it('renders the element the caller already rendered, with the caller\'s styles', () => {
    expect(cardSrc).toContain('createElement(');
    expect(cardSrc).toContain('{ ...style, background }');
    // No background configured → the card's own style object, untouched.
    expect(cardSrc).toContain('background ? { ...style, background } : style');
  });

  it('keeps the tiles clickable buttons and the membership card its existing element', () => {
    expect(cardSrc).toContain("type: 'button' as const");
    expect(homeSrc).toContain('as="button"');
    expect(homeSrc).toContain('style={styles.tile}');
    expect(homeSrc).toContain('style={styles.card}');
    expect(homeSrc).toContain("role=\"button\"");
  });

  it('renders the artwork as a background rather than an <img>', () => {
    expect(cardSrc).not.toContain('<img');
    expect(cardSrc).not.toContain('alt=');
  });
});

describe('the Members App knows only URLs (#728 §Fallback, §Performance)', () => {
  it('reads the resolved URLs off the theme payload — no request per section', () => {
    expect(cardSrc).toContain('theme?.members_images');
    expect(cardSrc).not.toContain('fetch(');
    expect(cardSrc).not.toContain('apiFetch');
  });

  it('implements no fallback of its own', () => {
    for (const src of [cardSrc, libSrc]) {
      expect(src).not.toContain('object_key');
      expect(src).not.toContain('storage_folder_prefix');
      expect(src).not.toContain('cordel/');
      expect(src).not.toContain('/Themes/');
    }
    // A missing section image is never substituted by the general background.
    expect(backgroundUrlForSlot({ background_url: 'https://r2/background.png' }, 'membership')).toBeNull();
  });
});
