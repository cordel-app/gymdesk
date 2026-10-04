import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  META_SEPARATOR,
  calendarEventMeta,
  calendarEventMetaLines,
  joinMetaParts,
} from '../lib/calendarEventMeta';

// #981 — the trainer and the space, shown on the event box itself.
//
// The rules worth asserting are the ones the ticket states rather than the
// markup: the values are the *occurrence's* own (§3), a missing one produces
// no line at all rather than a placeholder (§6), the Week view collapses both
// onto one truncated line while the Day view keeps them apart (§4/§7), and
// nothing about any of it touches the event's colour (§8).

const SRC = join(__dirname, '..');
const metaModule = readFileSync(join(SRC, 'lib', 'calendarEventMeta.ts'), 'utf-8');
const calendarPage = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Whose trainer and which space (#981 §3)', () => {
  it('reads the occurrence\'s own names', () => {
    expect(calendarEventMeta({ trainer_name: 'Jane Smith', space_name: 'Studio 2' }))
      .toEqual({ trainer: 'Jane Smith', space: 'Studio 2' });
  });

  it('prefers the effective trainer, who actually delivered the session', () => {
    // A session read projects `effective_trainer_name` (#193); a manual
    // calendar entry does not, and falls through to its own trainer.
    expect(calendarEventMeta({
      trainer_name: 'John Smith',
      effective_trainer_name: 'Jane Smith',
      space_name: 'Studio 2',
    }).trainer).toBe('Jane Smith');
    expect(calendarEventMeta({ trainer_name: 'John Smith' }).trainer).toBe('John Smith');
    expect(calendarEventMeta({ trainer_name: 'John Smith', effective_trainer_name: null }).trainer)
      .toBe('John Smith');
  });

  it('takes no Activity Type default as a fallback', () => {
    // The whole point of §3: an occurrence retargeted away from the
    // Activity's defaults must read as its own trainer and space. The module
    // has no field to pass one in through.
    expect(Object.keys(calendarEventMeta({}))).toEqual(['trainer', 'space']);
    expect(stripComments(metaModule)).not.toMatch(/activity_type/);
  });
});

describe('Missing means absent, never a placeholder (#981 §6)', () => {
  it('answers null for every unusable name', () => {
    for (const value of [null, undefined, '', '   ', '\t\n']) {
      const meta = calendarEventMeta({ trainer_name: value as any, space_name: value as any });
      expect(meta.trainer, `${JSON.stringify(value)} should not become a line`).toBeNull();
      expect(meta.space).toBeNull();
    }
  });

  it('emits no line at all when the occurrence has neither', () => {
    const meta = calendarEventMeta({ trainer_name: null, space_name: null });
    expect(calendarEventMetaLines(meta, 'full')).toEqual([]);
    expect(calendarEventMetaLines(meta, 'compact')).toEqual([]);
    expect(joinMetaParts([null, null])).toBeNull();
  });

  it('never leaves a dangling separator when only one of the two exists', () => {
    const trainerOnly = calendarEventMeta({ trainer_name: 'Jane Smith' });
    const spaceOnly = calendarEventMeta({ space_name: 'Studio 2' });
    for (const layout of ['full', 'compact'] as const) {
      expect(calendarEventMetaLines(trainerOnly, layout)).toEqual(['Jane Smith']);
      expect(calendarEventMetaLines(spaceOnly, layout)).toEqual(['Studio 2']);
      for (const line of [...calendarEventMetaLines(trainerOnly, layout), ...calendarEventMetaLines(spaceOnly, layout)]) {
        expect(line).not.toContain(META_SEPARATOR.trim());
      }
    }
  });

  it('spells none of the placeholders the ticket rules out', () => {
    for (const banned of ['N/A', 'Unknown', 'Not assigned', 'not_assigned']) {
      expect(stripComments(metaModule)).not.toContain(banned);
    }
  });
});

describe('How much room the box has (#981 §4/§7)', () => {
  const meta = calendarEventMeta({ trainer_name: 'Jane Smith', space_name: 'Studio 2' });

  it('gives the Day view a line each', () => {
    expect(calendarEventMetaLines(meta, 'full')).toEqual(['Jane Smith', 'Studio 2']);
  });

  it('collapses the Week view onto one truncated line', () => {
    expect(calendarEventMetaLines(meta, 'compact')).toEqual(['Jane Smith · Studio 2']);
  });

  it('puts the trainer first in both, the more identifying of the two', () => {
    expect(calendarEventMetaLines(meta, 'full')[0]).toBe('Jane Smith');
    expect(calendarEventMetaLines(meta, 'compact')[0]!.startsWith('Jane Smith')).toBe(true);
  });
});

describe('The Day and Week views render it, the others are untouched (#981 §1)', () => {
  const page = stripComments(calendarPage);

  it('asks the module rather than reading the fields itself', () => {
    expect(page).toContain('calendarEventMeta(e)');
    expect(page).toContain("calendarEventMetaLines(meta, 'compact')");
    expect(page).toContain("calendarEventMetaLines(meta, 'full')");
    // The page no longer picks between the two trainer columns on its own.
    expect(page).not.toContain('e.effective_trainer_name');
    expect(page).not.toContain('e.space_name');
  });

  it('leaves the month cell as it was — title, time and badge only', () => {
    const month = page.split("if (viewType === 'dayGridMonth')")[1]!.split("if (viewType === 'timeGridWeek')")[0]!;
    expect(month).not.toContain('calendarEventMetaLines');
    expect(month).toContain('CalendarStatusBadge');
  });

  it('keeps the occupancy counts on a line of their own in the Day view', () => {
    // §7: the trainer and space lines are additive — the counts the day view
    // already carried are not dropped, and not folded into them either.
    expect(page).toContain('joinMetaParts([bookingCount, waitlistLine])');
  });

  it('truncates rather than overflowing the event', () => {
    const lines = calendarPage.split('\n').filter((l) => l.includes('metaLines') || l.includes("'compact')"));
    expect(lines.length).toBeGreaterThan(0);
    // Every meta line is rendered inside a nowrap/ellipsis div — the block
    // immediately after each `.map(` call.
    for (const marker of ["calendarEventMetaLines(meta, 'compact').map", 'metaLines.map']) {
      const after = calendarPage.split(marker)[1]!.slice(0, 300);
      expect(after, marker).toContain("whiteSpace: 'nowrap'");
      expect(after, marker).toContain("textOverflow: 'ellipsis'");
    }
  });
});

describe('It is text, never a colour (#981 §8)', () => {
  // The issue references in the prose are `#981`-shaped, so the colour check
  // reads the code alone.
  const code = stripComments(metaModule);

  it('declares no colour of its own and resolves no locale key', () => {
    // A person's name and a room's name are data, not copy — and a status or
    // an attribute that paints the box is #541, which #975 overturned.
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(code).not.toContain('useTranslations');
    expect(code).not.toMatch(/\bt\(/);
    expect(code).not.toMatch(/<[A-Za-z]/);
    expect(code).not.toContain('backgroundColor');
    expect(code).not.toContain('borderColor');
  });

  it('is pure — no fetch, no React, no component state', () => {
    expect(code).not.toContain('apiFetch');
    expect(code).not.toContain('useState');
    expect(code).not.toContain("from 'react'");
    expect(code).not.toContain('import');
  });
});
