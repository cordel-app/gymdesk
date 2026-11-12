// #2670 stage 1: every Member belongs to a Family. Each production writer of `members`
// must create the new member's family in the same transaction, through the one helper.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' || name === 'migrations' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('every member has a family (#2670)', () => {
  it('each INSERT INTO members is followed by createSoloFamily() in the same file', () => {
    const writers = sources(SRC).filter((f) => /INSERT INTO members\s*\(/.test(readFileSync(f, 'utf8')));
    expect(writers.length).toBeGreaterThan(0);
    for (const file of writers) {
      const text = readFileSync(file, 'utf8');
      const inserts = text.split(/INSERT INTO members\s*\(/).length - 1;
      const families = text.split(/await createSoloFamily\(/).length - 1;
      expect(families, file).toBeGreaterThanOrEqual(inserts);
    }
  });

  it('the family routes create solo families rather than leaving a member without one', () => {
    const text = readFileSync(join(SRC, 'api', 'families.ts'), 'utf8');
    expect(text).toContain("'family_required'");
    expect(text.split('createSoloFamily(').length - 1).toBeGreaterThanOrEqual(2);
  });
});
