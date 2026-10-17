// Where a **Calendar Event**'s own image lives and which objects a gym may delete
// (#1382, moved by #1765). Pure, like `activityImages.ts` (#1373), whose request
// validation the routes reuse: an event image is the shared WebP pipeline's
// 1080 x 1080 master plus a 256 x 256 thumbnail, scoped to one event.
//
// The keys sit under the gym's own `calendar_events/` folder:
// `<gym prefix>/calendar_events/<event_id>-<sanitized name>[-thumbnail].webp`,
// the name being the event's title (an Activity's name for a session without
// one). Before #1765 they sat under `activities/event-<id>-…`; those objects
// still render from their stored URL and are swept when their event's image is
// replaced or removed.

import { ACTIVITIES_FOLDER, CALENDAR_EVENTS_FOLDER, storageKeyFromObjectUrl } from '../infra/storage';
import { sanitizeActivityImageName } from './activityImages';

export function eventImageFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${CALENDAR_EVENTS_FOLDER}/`];
}

export function buildEventImageKey(folderPrefix: string, eventId: number | string, eventName: string): string {
  return `${folderPrefix}/${CALENDAR_EVENTS_FOLDER}/${eventId}-${sanitizeActivityImageName(eventName)}.webp`;
}

export function buildEventImageThumbnailKey(folderPrefix: string, eventId: number | string, eventName: string): string {
  return `${folderPrefix}/${CALENDAR_EVENTS_FOLDER}/${eventId}-${sanitizeActivityImageName(eventName)}-thumbnail.webp`;
}

/** Whether `url` is an event-specific object **this gym** owns — never an Activity's own image. */
export function isGymOwnedEventImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/${CALENDAR_EVENTS_FOLDER}/`)
    // #1382's original location, still referenced by events whose image was never replaced.
    || key.startsWith(`${folderPrefix}/${ACTIVITIES_FOLDER}/event-`);
}

/** The image an event shows: its own, else its Activity's, else none (the panel draws a placeholder). */
export function effectiveEventImageUrl(
  eventImageUrl: string | null | undefined,
  activityImageUrl: string | null | undefined,
): string | null {
  return eventImageUrl || activityImageUrl || null;
}
