/**
 * #966: what the API tells a client about a failure that reached the global
 * error handler.
 *
 * The handler used to answer `err.message` verbatim with a 500, so a driver
 * error reached the browser as a toast reading
 * `Unknown column 'b.result_type' in 'field list'` — a database implementation
 * detail, and one that names a column and a table alias to anyone who can
 * provoke it. The rule here is the smallest one that fixes that without
 * swallowing the messages routes write on purpose:
 *
 * - an error carrying an explicit HTTP `status` (`Object.assign(new Error(m),
 *   { status: 400 })`, body-parser's own 400/413) is a **deliberate** answer and
 *   keeps its message;
 * - anything else — a mysql2 error, a storage SDK error, a TypeError — is an
 *   unexpected failure, so the client gets a 500 and a generic sentence while
 *   the real error is logged server-side.
 *
 * Pure on purpose: the handler in `app.ts` is the one caller, and these two
 * decisions are unit-testable without an Express app or a database.
 */

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/** True when the thrower named an HTTP status, i.e. the error is an answer. */
function hasDeliberateStatus(err: any): boolean {
  const status = err?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
}

/** The status to answer with: the thrower's, or 500. */
export function httpErrorStatus(err: any): number {
  return hasDeliberateStatus(err) ? (err.status as number) : 500;
}

/**
 * The message to answer with: the thrower's when they named a status, and the
 * generic sentence otherwise — never a driver or SDK message.
 */
export function publicErrorMessage(err: any): string {
  if (!hasDeliberateStatus(err)) return INTERNAL_ERROR_MESSAGE;
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  return message === '' ? INTERNAL_ERROR_MESSAGE : message;
}
