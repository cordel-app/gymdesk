// #2445 — Members App Profile words the stored gender in the member's language.
// In the API suite because CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { memberGenderLabelKey } from '../../../apps/member/src/lib/memberGender';

describe('memberGenderLabelKey', () => {
  it('maps the three stored values, whatever their case', () => {
    expect(memberGenderLabelKey('Man')).toBe('profile.gender_man');
    expect(memberGenderLabelKey('woman')).toBe('profile.gender_woman');
    expect(memberGenderLabelKey(' Other ')).toBe('profile.gender_other');
  });
  it('leaves legacy free text and empties unmapped', () => {
    expect(memberGenderLabelKey('Non-binary')).toBeNull();
    expect(memberGenderLabelKey(null)).toBeNull();
  });
  it('has a translation of every key in en, es and ca', () => {
    for (const l of ['en', 'es', 'ca']) {
      const p = JSON.parse(readFileSync(join(__dirname, `../../../apps/member/locales/base/${l}.json`), 'utf8')).profile;
      for (const k of ['gender_man', 'gender_woman', 'gender_other']) expect(p[k]).toBeTruthy();
    }
  });
});
