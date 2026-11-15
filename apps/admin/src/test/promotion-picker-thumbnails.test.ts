import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2852 — the Assign Plan forms show each Promotion's own thumbnail in a
// circle beside its name. There is no component-test infra for apps/admin, so
// — like assign-plan-inline.test.ts — this pins the wiring down from source.

const SRC = join(__dirname, '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf-8');

const picker = read('components/PromotionPicker.tsx');
const callers = [
  'app/[locale]/plans/AssignPlanToMembersEditor.tsx',
  'app/[locale]/members/AssignPlanInlineEditor.tsx',
  // #2853: the Draft assigned plan's available-Promotions picker.
  'components/assignedPlan/AssignedPlanPromotions.tsx',
];
// #2853: the catalogue row → picker row mapping is shared by the plan pickers.
const sharedMapping = read('lib/assignablePromotions.ts');

describe('PromotionPicker thumbnails (#2852)', () => {
  it('draws the thumbnail through the shared circular MemberAvatar (placeholder included), opt-in', () => {
    expect(picker).toMatch(/import \{ MemberAvatar \} from '@\/components\/MemberAvatar'/);
    expect(picker).toMatch(/showThumbnails = false/);
    expect(picker).toMatch(/showThumbnails && \(\s*<MemberAvatar/);
  });

  it('keeps the checkbox before the thumbnail and the name after it', () => {
    const checkbox = picker.indexOf('type="checkbox"');
    const avatar = picker.indexOf('<MemberAvatar');
    const name = picker.indexOf('{p.name}');
    expect(checkbox).toBeGreaterThan(0);
    expect(avatar).toBeGreaterThan(checkbox);
    expect(name).toBeGreaterThan(avatar);
  });

  for (const file of callers) {
    it(`${file} passes the promotion's stored thumbnail and asks for thumbnails`, () => {
      const src = read(file);
      const mapping = /toPickerPromotion\(/.test(src) ? sharedMapping : src;
      expect(mapping).toMatch(/imageUrl: p\.image_thumbnail_url \?\? p\.image_url \?\? null/);
      expect(mapping).toMatch(/imageStamp: p\.modified_at/);
      expect(src).toMatch(/<PromotionPicker[\s\S]*?showThumbnails[\s\S]*?\/>/);
    });
  }
});
