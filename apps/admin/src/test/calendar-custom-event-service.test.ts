import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1891 — a custom calendar event picks the Professional Service it delivers.
// The API already stored it (#647); the custom-event panel never offered it.
// Source scan, the shape of the other calendar tests (no component infra).
const DIR = join(__dirname, '..', 'app', '[locale]', 'calendar');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

describe('custom event Professional Service (#1891)', () => {
  it('the panel offers the selector over the page’s services', () => {
    const panel = read('EventDetailsPanel.tsx');
    expect(panel).toContain("t('event_professional_service')");
    expect(panel).toContain('professionalServices');
    expect(panel).toContain('form.professional_service_id');
  });

  it('the page loads the stored value into the form and sends it on save', () => {
    const page = read('page.tsx');
    expect(page).toContain('professional_service_id: e.professional_service_id ? String(e.professional_service_id) : \'\'');
    expect(page).toContain('professional_service_id: form.professional_service_id ? Number(form.professional_service_id) : null');
    expect(page).toContain('professionalServices={professionalServices}');
  });
});
