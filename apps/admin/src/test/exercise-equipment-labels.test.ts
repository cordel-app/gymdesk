import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EQUIPMENT_VALUES, equipmentLabel, equipmentLabelKey } from '../lib/exerciseEquipment';

const root = path.resolve(__dirname, '../../../..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

describe('equipment labels (#2404)', () => {
  it('every catalogue value has a label in en/es/ca, in both apps', () => {
    for (const l of ['en', 'es', 'ca']) {
      const admin = read(`apps/admin/locales/base/${l}.json`).exercises;
      const member = read(`apps/member/locales/base/${l}.json`).exercise_media;
      for (const v of EQUIPMENT_VALUES) {
        const k = equipmentLabelKey(v)!;
        expect(admin[k], `admin ${l}:${v}`).toBeTruthy();
        expect(member[k], `member ${l}:${v}`).toBeTruthy();
      }
    }
  });
  it('unknown values fall back to the humanised value, never empty', () => {
    expect(equipmentLabel('sled', () => 'x', (v) => `H:${v}`)).toBe('H:sled');
    expect(equipmentLabel('body only', (k) => k, (v) => v)).toBe('equipment_body_only');
  });
});
