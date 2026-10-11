/**
 * #1391: what a staff communication is — a title and a message, both trimmed,
 * non-empty and capped. The one place a request body is judged; routes call it
 * and never restate the limits.
 */
export const COMMUNICATION_TITLE_MAX = 120;
export const COMMUNICATION_MESSAGE_MAX = 2000;

export const STAFF_COMMUNICATIONS_FEATURE = 'calendar.staff_communications';

export type CommunicationParse =
  | { ok: true; title: string; message: string }
  | { ok: false; error: string };

export function parseCommunicationInput(body: unknown): CommunicationParse {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.title !== 'string' || typeof b.message !== 'string') {
    return { ok: false, error: 'title and message are required' };
  }
  const title = b.title.trim();
  const message = b.message.trim();
  if (!title) return { ok: false, error: 'title is required' };
  if (!message) return { ok: false, error: 'message is required' };
  if (title.length > COMMUNICATION_TITLE_MAX) {
    return { ok: false, error: `title must be at most ${COMMUNICATION_TITLE_MAX} characters` };
  }
  if (message.length > COMMUNICATION_MESSAGE_MAX) {
    return { ok: false, error: `message must be at most ${COMMUNICATION_MESSAGE_MAX} characters` };
  }
  return { ok: true, title, message };
}
