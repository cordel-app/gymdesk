// #2686: what makes an occurrence Private.
import { describe, expect, it } from 'vitest';
import { isPrivateActivityType, isPrivateOccurrence } from '../domain/privateEventVisibility';

const base = { eventType: null, activityTypeId: 1, publicEvent: false, activityServiceCount: 0, eligibleServicesOverride: false };

describe('isPrivateOccurrence', () => {
  it('a manual event is decided by its own type', () => {
    expect(isPrivateOccurrence({ ...base, eventType: 'private', publicEvent: true })).toBe(true);
    expect(isPrivateOccurrence({ ...base, eventType: 'public' })).toBe(false);
    expect(isPrivateOccurrence({ ...base, eventType: 'professional_services' })).toBe(false);
  });
  it('an occurrence of a Private Activity is private', () => {
    expect(isPrivateOccurrence(base)).toBe(true);
  });
  it('public, service-restricted and overridden occurrences are not', () => {
    expect(isPrivateOccurrence({ ...base, publicEvent: true })).toBe(false);
    expect(isPrivateOccurrence({ ...base, activityServiceCount: 2 })).toBe(false);
    expect(isPrivateOccurrence({ ...base, eligibleServicesOverride: true })).toBe(false);
    expect(isPrivateOccurrence({ ...base, activityTypeId: null })).toBe(false);
  });
  it('an Activity Type is Private when not public and naming no service', () => {
    expect(isPrivateActivityType(false, 0)).toBe(true);
    expect(isPrivateActivityType(false, 1)).toBe(false);
    expect(isPrivateActivityType(true, 0)).toBe(false);
  });
});
