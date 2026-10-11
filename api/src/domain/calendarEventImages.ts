// Where a **Calendar Event**'s own image lives and which objects a gym may delete
// (#1382). Pure, like `activityImages.ts` (#1373), whose size, type and byte
// validation it reuses rather than restates: an event image is an Activity image
// scoped to one occurrence.
//
// The key sits under the gym's existing `activities/` folder, prefixed `event-`
// so it can never collide with an Activity's own `<activity_id>-<name>.png`:
// `<gym prefix>/activities/event-<event_id>-<sanitized activity name>.png`.
// No new first-level folder, so no new marker to write.

import { ACTIVITIES_FOLDER, storageKeyFromObjectUrl } from '../infra/storage';
import { sanitizeActivityImageName } from './activityImages';

export {
  ACTIVITY_IMAGE_MAX_BYTES as EVENT_IMAGE_MAX_BYTES,
  ACTIVITY_IMAGE_MIME as EVENT_IMAGE_MIME,
  ACTIVITY_IMAGE_REJECTION_MESSAGES as EVENT_IMAGE_REJECTION_MESSAGES,
  activityImageFolderKeys as eventImageFolderKeys,
  validateActivityImage as validateEventImage,
} from './activityImages';

export function buildEventImageKey(folderPrefix: string, eventId: number | string, activityName: string): string {
  return `${folderPrefix}/${ACTIVITIES_FOLDER}/event-${eventId}-${sanitizeActivityImageName(activityName)}.png`;
}

/** Whether `url` is an event-specific object **this gym** owns — never an Activity's own image. */
export function isGymOwnedEventImageUrl(
  url: string | null | undefined,
  folderPrefix: string | null | undefined,
): boolean {
  if (!url || !folderPrefix) return false;
  const key = storageKeyFromObjectUrl(url);
  if (!key) return false;
  return key.startsWith(`${folderPrefix}/${ACTIVITIES_FOLDER}/event-`);
}

/** The image an event shows: its own, else its Activity's, else none (the panel draws a placeholder). */
export function effectiveEventImageUrl(
  eventImageUrl: string | null | undefined,
  activityImageUrl: string | null | undefined,
): string | null {
  return eventImageUrl || activityImageUrl || null;
}
