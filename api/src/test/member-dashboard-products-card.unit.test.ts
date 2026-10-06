import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1116 — the Members App dashboard's My Membership card is renamed **My
// Products & Services** and moved into the navigation tile grid, so it sits
// beside My Goals in the last row instead of occupying a full-width row
// underneath it.
//
// Both halves are assertable from the source: the title is a locale key of its
// own (the My Membership *page* keeps `membership.title`, which this ticket
// does not rename), and "beside My Goals" is the card being a cell of the one
// grid the tiles already live in rather than a second grid, a media query or a
// width of its own.
//
// This gate lives in the API suite for #1009's reason: CI runs `npm test` in
// `api/` only, so a scan that has to hold on every push belongs here even when
// what it scans is a frontend.

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member');
const HOME_PATH = join(MEMBER, 'src', 'app', '[locale]', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const homeSrc = readFileSync(HOME_PATH, 'utf-8');

/** The `<section style={styles.tileGrid}>…</section>` block, comments and all. */
function tileGrid(src: string): string {
  const start = src.indexOf('<section style={styles.tileGrid}>');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('</section>', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const grid = tileGrid(homeSrc);

describe('the card is renamed (#1116 §1)', () => {
  it('takes its title from its own key, not the My Membership page heading', () => {
    expect(grid).toContain("t('home.products_services')");
    // The page at /membership still reads "My membership" — renaming that
    // heading is not this ticket's, and sharing one key would rename both.
    expect(homeSrc).not.toContain("t('membership.title')");
  });

  it('is translated in all three languages, and says Products in each', () => {
    const expected: Record<string, string> = { en: 'Products', es: 'Productos', ca: 'Productes' };
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(
        readFileSync(join(MEMBER, 'locales', 'base', `${code}.json`), 'utf-8'),
      );
      const value = messages.home?.products_services;
      expect(value, code).toBeTruthy();
      expect(value, code).toContain(expected[code]);
    }
  });
});

describe('the card always has a visual (#1150)', () => {
  it('shows a Products icon only while the slot has no artwork', () => {
    expect(homeSrc).toContain("useSectionImageUrl('membership') !== null");
    expect(grid).toContain('{!hasProductsImage && <span style={styles.tileIcon}>');
  });

  it('says My Products, without Services, in every language', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(
        readFileSync(join(MEMBER, 'locales', 'base', `${code}.json`), 'utf-8'),
      );
      expect(messages.home.products_services, code).not.toMatch(/Servei|Servicio|Service/);
    }
  });
});

describe('the card is a cell of the tile grid (#1116 §2, §3)', () => {
  it('renders inside the grid, after My Goals', () => {
    expect(grid).toContain('<MembersSectionCard slot="membership"');
    expect(grid.indexOf('slot="personal_goals"')).toBeLessThan(
      grid.indexOf('slot="membership"'),
    );
  });

  it('no longer sits in a full-width section of its own', () => {
    // The grid is the last thing the page renders: between it and `</main>`
    // there is no section left, which is where the full-width card used to be.
    const gridEnd = homeSrc.indexOf('</section>', homeSrc.indexOf('<section style={styles.tileGrid}>'));
    const tail = homeSrc.slice(gridEnd, homeSrc.indexOf('</main>', gridEnd));
    expect(tail).not.toContain('styles.section');
    expect(tail).not.toContain('MembersSectionCard');
  });

  it('keeps the grid itself — two equal columns, one gap, no second grid', () => {
    expect(homeSrc).toContain("tileGrid:        { display: 'grid', gridTemplateColumns: '1fr 1fr'");
    expect(homeSrc.match(/display: 'grid'/g)).toHaveLength(1);
    // The cards stack by the grid's own responsive behaviour (#1116 §3); a
    // media query here would be a second layout rule for one cell, and the
    // Members App has no stylesheet to put one in.
    expect(homeSrc).not.toContain('@media');
  });

  it('sizes itself from the grid rather than from a width of its own', () => {
    const style = homeSrc.match(/productsTile:\s*{[^}]*}/)![0];
    expect(style).not.toMatch(/\bwidth\b|\bmaxWidth\b|\bminHeight\b|gridColumn/);
    expect(style).toContain('...sectionCardStyle');
  });
});

describe('nothing else about the card changes (#1116 §4)', () => {
  it('keeps its theme artwork slot, and adds no new one', () => {
    expect(homeSrc.match(/slot="/g)).toHaveLength(6);
  });

  it('keeps its feature flag, its destination and its contents', () => {
    expect(grid).toContain("featureEnabled('member_web.my_membership')");
    expect(grid).toContain('`/${locale}/membership`');
    expect(grid).toContain('membership.plan_name');
    expect(grid).toContain("t('home.expires_on'");
    expect(grid).toContain("t('membership.ongoing')");
    expect(grid).toContain("t('home.no_membership')");
  });

  it('keeps the Active badge, in the shared status tone (#983)', () => {
    expect(grid).toContain('<StatusPill status={membership.status}');
    expect(homeSrc).toContain('statusPillStyle(statusTone(status))');
  });

  it('spells no colour of its own — the surface and the border are the theme\'s', () => {
    const style = homeSrc.match(/productsTile:\s*{[^}]*}/)![0]
      + homeSrc.match(/productsStatusRow:\s*{[^}]*}/)![0];
    // `sectionCardStyle` carries the background and the Section Cards border
    // (#983/#833); the only literal here is the tiles' own neutral shadow.
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(style).not.toMatch(/background:|borderColor|\bcolor:/);
  });
});
