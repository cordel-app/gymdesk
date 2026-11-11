/**
 * #2661: the save queue behind an inline editor that persists every change as
 * it is made (the Nutrition Plan meal and its ingredients).
 *
 * Saves are sent one at a time, in order, and only the newest value waiting
 * behind an in-flight request is sent next — the values in between are
 * dropped, because the newest one already contains them. So an older request
 * can never land after a newer one and overwrite it, and a burst of edits
 * costs at most two requests. Pure: no React, no fetch.
 */
export interface LatestWinsSaveHooks<T> {
  /** A request for `value` is about to be sent. */
  onStart?: (value: T) => void;
  /** The newest value was persisted and nothing newer is waiting. */
  onSuccess?: (value: T) => void;
  /** The newest value failed and nothing newer is waiting to replace it. */
  onError?: (error: unknown, value: T) => void;
}

export interface LatestWinsSaver<T> {
  /** Persist `value`, after whatever is in flight. */
  save: (value: T) => Promise<void>;
  /** True while a request is in flight or one is waiting. */
  busy: () => boolean;
}

export function createLatestWinsSaver<T>(
  send: (value: T) => Promise<unknown>,
  hooks: LatestWinsSaveHooks<T> = {},
): LatestWinsSaver<T> {
  let inFlight: Promise<void> | null = null;
  let pending: { value: T } | null = null;

  async function drain(first: T): Promise<void> {
    let value = first;
    for (;;) {
      hooks.onStart?.(value);
      let error: unknown = null;
      let failed = false;
      try {
        await send(value);
      } catch (err) {
        failed = true;
        error = err;
      }
      if (pending) {
        // A newer value is waiting: it supersedes this one, whatever happened.
        value = pending.value;
        pending = null;
        continue;
      }
      if (failed) hooks.onError?.(error, value);
      else hooks.onSuccess?.(value);
      return;
    }
  }

  return {
    save(value: T) {
      if (inFlight) {
        pending = { value };
        return inFlight;
      }
      inFlight = drain(value).finally(() => { inFlight = null; });
      return inFlight;
    },
    busy: () => inFlight !== null,
  };
}
