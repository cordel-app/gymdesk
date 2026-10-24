import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1892 stage 5 — weekday header and event card colours. Both apps carry the
// same CSS (they share no frontend module), so one source-level check reads
// both sheets. Visual verification needs a running stack and was not done.

const sheets = [
  join(__dirname, '..', '..', '..', 'admin', 'src', 'components', 'CalendarThemeStyles.tsx'),
  join(__dirname, '..', 'components', 'CalendarThemeStyles.tsx'),
].map((p) => readFileSync(p, 'utf-8'));

describe('weekday header and event cards (#1892 stage 5)', () => {
  it.each(sheets.map((s, i) => [i === 0 ? 'admin' : 'member', s] as const))(
    '%s sheet separates the header and uses a left accent over a soft surface',
    (_name, css) => {
      expect(css).toContain('.fc-scrollgrid-section-header > th');
      expect(css).toContain('.fc-col-header-cell.fc-day-today');
      expect(css).toContain('border-width: 0 0 0 4px');
      expect(css).toContain('background-clip: padding-box');
      expect(css).toContain('var(--gd-calendar-day-text, #111827) !important');
      // theme tokens only: no hue is introduced by the card rule
      const rule = css.slice(css.indexOf('.fc-event.gd-event-colored:not(.fc-bg-event) {'));
      expect(rule.slice(0, rule.indexOf('}'))).not.toMatch(/#[0-9a-fA-F]{6}\b(?!\))/);
    },
  );

  it('the Members App marks coloured events so the card rule reaches them', () => {
    const page = readFileSync(join(__dirname, '..', 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
    expect(page).toContain("classNames: ['gd-event-colored']");
  });
});
