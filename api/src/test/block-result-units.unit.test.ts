import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOCK_RESULT_UNITS,
  BLOCK_TYPE_RESULT_UNITS,
  parseBlockLogResult,
  parseBlockResultUnit,
} from '../domain/blockResultUnits';

describe('parseBlockResultUnit (#1232)', () => {
  it('treats absent / empty as no global result', () => {
    expect(parseBlockResultUnit('AMRAP', undefined)).toEqual({ unit: null });
    expect(parseBlockResultUnit('Standard', '')).toEqual({ unit: null });
  });

  it('accepts a unit the type allows', () => {
    expect(parseBlockResultUnit('AMRAP', 'rounds')).toEqual({ unit: 'rounds' });
    expect(parseBlockResultUnit('Circuit', 'Minutes')).toEqual({ unit: 'minutes' });
  });

  it('refuses unknown units, units outside the type, and any unit on an unsupported type', () => {
    expect(typeof parseBlockResultUnit('AMRAP', 'furlongs')).toBe('string');
    expect(typeof parseBlockResultUnit('Tabata', 'minutes')).toBe('string');
    expect(typeof parseBlockResultUnit('Standard', 'rounds')).toBe('string');
    expect(typeof parseBlockResultUnit('Superset', 'reps')).toBe('string');
    expect(typeof parseBlockResultUnit('AMRAP', 5)).toBe('string');
  });

  it('only offers units from the declared vocabulary', () => {
    for (const units of Object.values(BLOCK_TYPE_RESULT_UNITS)) {
      for (const u of units) expect(BLOCK_RESULT_UNITS).toContain(u);
    }
  });
});

describe('parseBlockLogResult (#1232)', () => {
  it('allows no result whatever the block, so Mark done stays independent', () => {
    expect(parseBlockLogResult(null, null)).toEqual({ value: null });
    expect(parseBlockLogResult('rounds', '  ')).toEqual({ value: null });
  });

  it('refuses a value for a block with no unit', () => {
    expect(typeof parseBlockLogResult(null, '8')).toBe('string');
  });

  it('validates the number against the unit', () => {
    expect(parseBlockLogResult('rounds', '8')).toEqual({ value: '8' });
    expect(parseBlockLogResult('minutes', '10.5')).toEqual({ value: '10.5' });
    expect(typeof parseBlockLogResult('rounds', '7.5')).toBe('string');
    expect(typeof parseBlockLogResult('minutes', '-1')).toBe('string');
    expect(typeof parseBlockLogResult('reps', '21:04')).toBe('string');
  });
});

describe('every block writer carries result_unit (#1232)', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', 'api', f), 'utf8');
  it('names result_unit in each INSERT into a block table', () => {
    for (const f of ['workout-templates.ts', 'platform-workout-templates.ts', 'training-plans.ts', 'training-plan-creation.ts']) {
      const text = src(f);
      const re = /INSERT INTO (workout_blocks|workout_template_blocks)\b[\s\S]{0,400}?VALUES/g;
      for (const m of text.matchAll(re)) expect(m[0], `${f}: ${m[1]}`).toContain('result_unit');
    }
  });
});
