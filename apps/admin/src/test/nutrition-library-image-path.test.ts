import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1035 §4/§5 — a gym food's image is uploaded to the **food's own** route, so
// the object key can carry its id and name (`nutrition/<food_id>-<name>.<ext>`).
// The generic `POST /storage/uploads/nutrition-image` it replaced never saw the
// row, which is why that key was `Nutrition/Images/<uuid>.<ext>` and why it is
// gone from the API.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so the wiring is pinned by scanning the source.

const SRC = join(__dirname, '..');
const pageSrc = readFileSync(
  join(SRC, 'app', '[locale]', 'nutrition', 'nutrition-library', 'page.tsx'),
  'utf8',
);
const fieldSrc = readFileSync(join(SRC, 'components', 'ImageUploadField.tsx'), 'utf8');

describe('the gym Nutrition Library uploads to the food’s own route (#1035)', () => {
  it('posts to /nutrition-library/<id>/image', () => {
    expect(pageSrc).toContain('uploadPath={`/nutrition-library/${itemId}/image`}');
  });

  it('no longer names the retired generic upload route', () => {
    expect(pageSrc).not.toContain('/storage/uploads/nutrition-image');
  });

  it('offers no image control while the food does not exist yet', () => {
    // The key is built from the row's id, so there is nothing to upload against
    // until it has one — the create form says so instead, as Cordel's Base
    // library already does.
    expect(pageSrc).toContain("itemId === null ? (");
    expect(pageSrc).toContain("t('nutrition_library.image_after_create')");
  });

  it('passes the row’s id from the edit form and null from the create form', () => {
    expect(pageSrc).toContain("t('nutrition_library.create'), null, newNameRef");
    expect(pageSrc).toContain("t('nutrition_library.save'), item.id");
  });
});

describe('ImageUploadField reads either response shape (#1035)', () => {
  it('takes `url` from a generic upload and `image_url` from a per-row route', () => {
    expect(fieldSrc).toContain('onChange(result.url ?? result.image_url ?? null)');
  });
});
