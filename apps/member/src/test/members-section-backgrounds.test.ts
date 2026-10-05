import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BACKGROUND_SCRIM_ALPHA,
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
    // #1036's section, painted by #1038's seventh slot.
    ['nav.goals', 'personal_goals'],
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

  it('leaves the Next Booking card alone — it is not one of the sections', () => {
    // The only surfaces that take artwork are the five tiles and My Membership.
    expect(homeSrc.match(/slot="/g)).toHaveLength(6);
  });

  it('keeps the general page background on #725\'s component rather than restating it here', () => {
    expect(homeSrc).not.toContain('slot="background"');
    expect(homeSrc).not.toContain('MembersBackground');
  });
});

describe('painting a card (#728 §Visual Treatment, #982)', () => {
  it('covers and centres the artwork, so it keeps its aspect ratio', () => {
    const value = cardBackgroundStyleValue('https://r2/calendar.png')!;
    expect(value).toContain('url("https://r2/calendar.png")');
    expect(value).toContain('center center / cover no-repeat');
    expect(value).not.toContain('100% 100%');
  });

  it('scrolls with its card, unlike the page background, which is fixed', () => {
    expect(cardBackgroundStyleValue('https://r2/calendar.png')).toContain('no-repeat scroll');
    expect(backgroundStyleValue('https://r2/background.png', null)).toContain('no-repeat fixed');
  });

  it('paints the uploaded image at full opacity — no scrim, overlay or blend (#982 §2)', () => {
    // #728 laid the theme's card colour over the artwork at 0.82, which washed
    // a black photograph out to grey. The card's artwork is now the image and
    // nothing else, so the uploaded colours and contrast are what the member
    // sees.
    const value = cardBackgroundStyleValue('https://r2/calendar.png')!;
    expect(value).not.toContain('linear-gradient');
    expect(value).not.toContain('rgba(');
    expect(value).toBe('url("https://r2/calendar.png") center center / cover no-repeat scroll');
  });

  it('takes no scrim argument at all, so no caller can reintroduce one', () => {
    expect(cardBackgroundStyleValue.length).toBe(1);
    expect(libSrc).not.toContain('CARD_SCRIM_ALPHA');
    expect(cardSrc).not.toContain('hexToRgba');
    expect(cardSrc).not.toContain('opacity');
  });

  it('keeps the page background\'s own scrim — a different surface with a different job', () => {
    // The general background sits under every page's text and controls at
    // once, so #982's "the image is the tile's primary visual" does not reach
    // it; §Apply-to says it follows its existing purpose.
    expect(BACKGROUND_SCRIM_ALPHA).toBeGreaterThan(0);
    expect(BACKGROUND_SCRIM_ALPHA).toBeLessThan(1);
    const scrim = hexToRgba('#101828', BACKGROUND_SCRIM_ALPHA)!;
    expect(backgroundStyleValue('https://r2/background.png', scrim)!.startsWith('linear-gradient(')).toBe(true);
  });

  it('paints nothing for a slot the theme does not configure', () => {
    expect(cardBackgroundStyleValue(null)).toBeNull();
    expect(backgroundUrlForSlot({ calendar_url: null }, 'calendar')).toBeNull();
  });
});

describe('a custom image replaces the default icon (#982 §1)', () => {
  it('asks one place whether the slot has artwork', () => {
    expect(cardSrc).toContain('export function useSectionImageUrl');
    expect(homeSrc).toContain('useSectionImageUrl');
    // The tile never reads the theme payload for itself.
    expect(homeSrc).not.toContain('members_images');
  });

  it('renders the default emoji only when there is no artwork', () => {
    expect(homeSrc).toContain('const hasImage = useSectionImageUrl(slot) !== null;');
    expect(homeSrc).toContain('{!hasImage && <span style={styles.tileIcon}>{icon}</span>}');
  });

  it('keeps the default emojis themselves untouched', () => {
    for (const icon of ['📅', '🏋️', '🎟️', '🥗']) {
      expect(homeSrc).toContain(`icon="${icon}"`);
    }
  });

  it('adds no placeholder or second asset in the icon\'s place', () => {
    expect(homeSrc).not.toContain('<img');
    expect(cardSrc).not.toContain('<img');
  });

  it('keeps the tile the same box, so the artwork fills the height the icon gave it', () => {
    expect(homeSrc).toContain('tileWithImage:');
    expect(homeSrc).toContain('{ ...styles.tile, ...styles.tileWithImage }');
    // …and a tile with no artwork keeps today's style object exactly.
    expect(homeSrc).toContain(': styles.tile}');
  });

  it('leaves the label visible in both states', () => {
    expect(homeSrc).toContain('<span style={styles.tileLabel}>{label}</span>');
  });
});

describe('the section card is a background, not a redesign (#728 §Preserve Existing UI)', () => {
  it('renders the element the caller already rendered, with the caller\'s styles', () => {
    expect(cardSrc).toContain('createElement(');
    // The caller's own styles are spread first, so nothing of theirs is
    // dropped, and the artwork is applied only for a slot the theme
    // configures. Since #833 §4 the card also carries the theme's Section
    // Cards border — the one thing a Section Card gains unconditionally —
    // which #983 moved into `lib/memberChrome.ts` so the content cards of the
    // sections this component does not wrap carry the same border.
    expect(cardSrc).toContain('...style');
    expect(cardSrc).toContain('...(background ? { background } : {})');
    expect(cardSrc).toContain('...sectionCardBorder');
  });

  it('keeps the tiles clickable buttons and the membership card its existing element', () => {
    expect(cardSrc).toContain("type: 'button' as const");
    expect(homeSrc).toContain('as="button"');
    expect(homeSrc).toContain('styles.tile');
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
      expect(src).not.toContain('/themes/');
    }
    // A missing section image is never substituted by the general background.
    expect(backgroundUrlForSlot({ background_url: 'https://r2/background.png' }, 'membership')).toBeNull();
  });
});
