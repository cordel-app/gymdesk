import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #3173 — Cordel → Muscles: each thumbnail opens its own full image (the 1080 × 1080 master) in
// the app's image viewer, without expanding the row; the viewer is the shared modal, which keeps
// the aspect ratio (max 1080 px wide, height auto) and shows "No image" when the file fails.
const src = readFileSync(join(__dirname, '../app/[locale]/cordel/muscles/page.tsx'), 'utf8');

describe('#3173 muscle thumbnails open the image viewer', () => {
  it('makes each available thumbnail its own button that opens the master image', () => {
    expect(src).toContain("full: row.image_male_url");
    expect(src).toContain("full: row.image_female_url");
    expect(src).toContain('data-muscle-thumbnail={sex}');
    expect(src).toContain('e.stopPropagation(); setViewing(');
    expect(src).toContain('imageUrl: full ?? src');
  });
  it('renders the shared viewer and closes it without touching the list state', () => {
    expect(src).toContain('<ProfessionalServiceImageModal');
    expect(src).toContain('onClose={() => setViewing(null)}');
    const modal = readFileSync(join(__dirname, '../components/professionalServices/ProfessionalServiceImageModal.tsx'), 'utf8');
    expect(modal).toContain('maxWidth: 1080, height: \'auto\'');
    expect(modal).toContain('onError={() => setBroken(true)}');
  });
});
