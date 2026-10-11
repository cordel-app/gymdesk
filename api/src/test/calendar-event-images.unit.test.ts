import { describe, expect, it } from 'vitest';
import {
  buildEventImageKey,
  effectiveEventImageUrl,
  isGymOwnedEventImageUrl,
} from '../domain/calendarEventImages';
import { buildActivityImageKey } from '../domain/activityImages';

describe('calendar event images (#1382)', () => {
  it('keys an event image under the gym activities folder, apart from the Activity\'s own key', () => {
    const eventKey = buildEventImageKey('gyms/g1-demo', 42, 'Yoga Flow');
    const activityKey = buildActivityImageKey('gyms/g1-demo', 7, 'Yoga Flow');
    expect(eventKey).toBe('gyms/g1-demo/activities/event-42-Yoga-Flow.png');
    expect(eventKey).not.toBe(activityKey);
  });

  it('is deterministic per event, so replacing overwrites its own object', () => {
    expect(buildEventImageKey('p', 1, 'A')).toBe(buildEventImageKey('p', 1, 'A'));
    expect(buildEventImageKey('p', 1, 'A')).not.toBe(buildEventImageKey('p', 2, 'A'));
  });

  it('prefers the event image, then the Activity image, then none', () => {
    expect(effectiveEventImageUrl('e.png', 'a.png')).toBe('e.png');
    expect(effectiveEventImageUrl(null, 'a.png')).toBe('a.png');
    expect(effectiveEventImageUrl(null, null)).toBeNull();
    expect(effectiveEventImageUrl('', undefined)).toBeNull();
  });

  it('never treats an Activity\'s own object or another gym\'s as deletable', () => {
    const prefix = 'gyms/g1-demo';
    expect(isGymOwnedEventImageUrl(null, prefix)).toBe(false);
    expect(isGymOwnedEventImageUrl('https://x.example/gyms/g1-demo/activities/7-Yoga.png', prefix)).toBe(false);
    expect(isGymOwnedEventImageUrl('https://x.example/gyms/g2-other/activities/event-1-Yoga.png', prefix)).toBe(false);
  });
});
