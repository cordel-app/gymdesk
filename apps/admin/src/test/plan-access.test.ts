import { describe, it, expect } from 'vitest';
import { planAccessLabel } from '../lib/planAccess';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';

describe('planAccessLabel (#2802)', () => {
  it('names every granted center', () => {
    expect(planAccessLabel({ all_centers: false, online: false, centers: [{ id: 1, name: 'North' }, { id: 2, name: 'South' }] }))
      .toEqual({ key: 'access_centers', values: { centers: 'North, South' } });
  });
  it('says On-line beside the centers, and alone', () => {
    expect(planAccessLabel({ all_centers: false, online: true, centers: [{ id: 1, name: 'North' }] }))
      .toEqual({ key: 'access_centers_online', values: { centers: 'North' } });
    expect(planAccessLabel({ all_centers: false, online: true, centers: [] })).toEqual({ key: 'access_online' });
  });
  it('reads All Centers without listing any', () => {
    expect(planAccessLabel({ all_centers: true, online: false, centers: [] })).toEqual({ key: 'access_all_centers' });
    expect(planAccessLabel({ all_centers: true, online: true, centers: [] })).toEqual({ key: 'access_all_centers_online' });
  });
  it('answers null for an entry that grants nothing', () => {
    expect(planAccessLabel({ all_centers: false, online: false, centers: [] })).toBeNull();
  });
  it('has every key in the three locales', () => {
    const keys = ['access_all_centers', 'access_all_centers_online', 'access_centers', 'access_centers_online', 'access_online'];
    for (const locale of [en, es, ca] as any[]) {
      for (const k of keys) expect(typeof locale.assigned_plans_page[k]).toBe('string');
    }
  });
});
