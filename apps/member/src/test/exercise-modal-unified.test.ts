import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2419: My Training and My Progress share one exercise modal; muscles are text lines, not chips.
const C = join(__dirname, '..', 'components');
const read = (f: string) => readFileSync(join(C, f), 'utf8');

describe('unified exercise detail modal (#2419)', () => {
  it('My Progress renders the shared modal, not its own', () => {
    expect(read('MemberProgress.tsx')).toMatch(/<ExerciseDetailsModal/);
    expect(read('ExerciseDetailsDialog.tsx')).toMatch(/<ExerciseDetailsModal/);
  });
  it('muscles show Primary and Secondary lines without chips', () => {
    const info = read('ExerciseInfo.tsx');
    expect(info).toMatch(/muscles_primary/);
    expect(info).toMatch(/muscles_secondary/);
    expect(info).not.toMatch(/chip/);
    expect(info).toMatch(/primary\.length > 0 &&/);
    expect(info).toMatch(/secondary\.length > 0 &&/);
  });
});
