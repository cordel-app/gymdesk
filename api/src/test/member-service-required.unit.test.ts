// #1189 stage 4 — a booking refused with `professional_service_required` routes
// the member to the Products that unlock it. Pure halves only (API suite, because
// CI runs `npm test` in `api/` only).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseProfessionalServiceFilter } from '../domain/memberProductCatalogue';
import {
  productsPathForServices,
  requiredServiceIds,
  serviceFilterFromParam,
} from '../../../apps/member/src/lib/serviceRequired';

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member');

describe('parseProfessionalServiceFilter', () => {
  it('treats absence as no filter', () => {
    expect(parseProfessionalServiceFilter(undefined)).toEqual({ ok: true, ids: [] });
    expect(parseProfessionalServiceFilter('')).toEqual({ ok: true, ids: [] });
  });
  it('parses a de-duplicated comma list', () => {
    expect(parseProfessionalServiceFilter('3,5,3')).toEqual({ ok: true, ids: [3, 5] });
  });
  it('refuses garbage instead of widening to no filter', () => {
    for (const bad of ['a', '1,,2', '0', '-1', '1.5', ['1']]) {
      expect(parseProfessionalServiceFilter(bad).ok).toBe(false);
    }
  });
});

describe('Members App routing helpers', () => {
  const refusal = {
    code: 'professional_service_required',
    body: { professional_services: [{ id: 4, name: 'PT' }, { id: 4, name: 'PT' }, { id: 'x' }] },
  };
  it('reads the service ids only off the gate refusal', () => {
    expect(requiredServiceIds(refusal)).toEqual([4]);
    expect(requiredServiceIds({ code: 'other', body: refusal.body })).toEqual([]);
    expect(requiredServiceIds(null)).toEqual([]);
  });
  it('builds and reads back the filtered path', () => {
    expect(productsPathForServices([4, 7])).toBe('/membership?professional_service_ids=4,7');
    expect(productsPathForServices([])).toBe('/membership');
    expect(serviceFilterFromParam('4,7')).toEqual([4, 7]);
    expect(serviceFilterFromParam('4,x')).toEqual([]);
  });
  it('has the copy in all three locales', () => {
    for (const l of ['en', 'es', 'ca']) {
      const json = JSON.parse(readFileSync(join(MEMBER, 'locales', 'base', `${l}.json`), 'utf-8'));
      expect(json.member_calendar.buy_sessions_cta).toBeTruthy();
      expect(json.membership.products_filtered_notice).toBeTruthy();
      expect(json.membership.products_show_all).toBeTruthy();
    }
  });
});
