import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_META_SEPARATOR,
  memberEventMeta,
  memberEventMetaLine,
} from '../lib/calendarEventDisplay';

// #981 — the trainer and the space on a Members App calendar event.
//
// The Members App half of the ticket, under the same rules as the Admin's
// (`apps/admin/src/test/calendar-event-meta.test.ts`): the values are the
// occurrence's own (§3), a missing one produces no line rather than a
// placeholder (§6), the line is compact in both time-grid views (§5/§7), and
// none of it touches the event's colour (§8). The two apps share no frontend
// module, so each keeps its own copy of the rule and its own test.

const SRC = join(__dirname, '..');
const displayModule = readFileSync(join(SRC, 'lib', 'calendarEventDisplay.ts'), 'utf-8');
const calendarPage = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'page.tsx'), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Whose trainer and which space (#981 §3)', () => {
  it('reads the occurrence\'s own names', () => {
    expect(memberEventMeta({ trainer_name: 'Jane Smith', space_name: 'Studio 2' }))
      .toEqual({ trainer: 'Jane Smith', space: 'Studio 2' });
    expect(memberEventMetaLine({ trainer_name: 'Jane Smith', space_name: 'Studio 2' }))
      .toBe('Jane Smith · Studio 2');
  });

  it('takes no Activity Type default as a fallback', () => {
    // §3's point: an occurrence retargeted away from the Activity's defaults
    // reads as its own trainer and space. There is no field to pass one in.
    expect(Object.keys(memberEventMeta({}))).toEqual(['trainer', 'space']);
  });
});

describe('Missing means absent, never a placeholder (#981 §6)', () => {
  it('answers null for every unusable name', () => {
    for (const value of [null, undefined, '', '   ', '\t\n']) {
      const meta = memberEventMeta({ trainer_name: value as any, space_name: value as any });
      expect(meta.trainer, `${JSON.stringify(value)} should not become a line`).toBeNull();
      expect(meta.space).toBeNull();
      expect(memberEventMetaLine({ trainer_name: value as any, space_name: value as any })).toBeNull();
    }
  });

  it('never leaves a dangling separator when only one of the two exists', () => {
    expect(memberEventMetaLine({ trainer_name: 'Jane Smith', space_name: null })).toBe('Jane Smith');
    expect(memberEventMetaLine({ trainer_name: null, space_name: 'Studio 2' })).toBe('Studio 2');
    for (const line of ['Jane Smith', 'Studio 2']) {
      expect(line).not.toContain(MEMBER_META_SEPARATOR.trim());
    }
  });

  it('spells none of the placeholders the ticket rules out', () => {
    for (const banned of ['N/A', 'Unknown', 'Not assigned']) {
      expect(stripComments(displayModule)).not.toContain(banned);
    }
  });
});

describe('The Day and Week views show both; the month cell is untouched (#981 §1/§5)', () => {
  const page = stripComments(calendarPage);

  it('asks the module for the line in the two time-grid views', () => {
    expect(page).toContain('memberEventMetaLine(s)');
    expect(page).toContain("arg.view.type === 'timeGridDay'");
    expect(page).toContain("arg.view.type === 'timeGridWeek'");
  });

  it('keeps the month cell on the trainer-alone line it has always had', () => {
    // §1: only the Day and Week views are in scope, and a month cell is a few
    // pixels tall.
    expect(page).toContain('timeGridView ? memberEventMetaLine(s) : s.trainer_name');
  });

  it('renders it truncated rather than overflowing the event', () => {
    const after = calendarPage.split('{metaLine && (')[1]!.slice(0, 300);
    expect(after).toContain("whiteSpace: 'nowrap'");
    expect(after).toContain("textOverflow: 'ellipsis'");
  });

  it('leaves the occupancy count and the status chip where they were', () => {
    // The line is additive — nothing the box already carried is dropped.
    expect(page).toContain('occupancy_count');
    expect(page).toContain('EVENT_STATUS_CHIP_STYLE');
  });
});

describe('It is text, never a colour (#981 §8)', () => {
  it('composes the line without declaring a colour or resolving a key', () => {
    // The colour half of this module stays the event's own (#976); the meta
    // half must not grow a hue, and a person's or a room's name is data
    // rather than copy, so there is no locale key for either.
    const section = displayModule.split('export interface MemberEventMetaSource')[1]!
      .split('export const EVENT_STATUS_CHIP_STYLE')[0]!;
    const code = stripComments(section);
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(code).not.toMatch(/\bt\(/);
    expect(code).not.toContain('background');
    expect(code).not.toMatch(/<[A-Za-z]/);
  });
});
