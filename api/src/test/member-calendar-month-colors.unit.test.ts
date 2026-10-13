import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1528 — the Members App Calendar's Month view lost its event colours.
// FullCalendar's dayGrid draws a *timed* event as a dot with no background
// unless the calendar says `eventDisplay="block"` (the Admin calendar does),
// so the per-event backgroundColor from #976 never showed in Month view.
// In the API suite because CI runs `npm test` in `api/` only.
describe('Members App Calendar month view', () => {
  it('draws events as blocks so their Activity Type colour is visible', () => {
    const src = readFileSync(
      join(__dirname, '../../../apps/member/src/app/[locale]/calendar/page.tsx'),
      'utf8',
    );
    expect(src).toMatch(/<FullCalendar[\s\S]*?eventDisplay="block"/);
  });
});
