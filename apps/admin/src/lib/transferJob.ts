/**
 * #2952 — the one Export / Import job of the Cordel transfer page, kept outside
 * any component. The page that starts it is only a view of it: leaving the page
 * unmounts the component but not the job, so coming back shows the live progress
 * (or the finished summary) instead of an empty screen. The job lives in this
 * module for as long as the admin app stays loaded in the tab (a navigation
 * inside the app keeps it; closing or reloading the tab ends it).
 *
 * Pure: no React, no fetch, no locale. A runner receives a context to report
 * through and to guard every awaited call with, so Cancel stops the job at once
 * instead of after the call that was in flight.
 */
import { emptySummary, recordOutcome, type TransferSummary } from './entityTransfer';

export type TransferOperation = 'export' | 'import';

export interface TransferJobState {
  operation: TransferOperation;
  done: number;
  total: number;
  finished: boolean;
  cancelled: boolean;
  summary: TransferSummary;
  error: string | null;
}

export class TransferCancelled extends Error {
  constructor() {
    super('transfer cancelled');
    this.name = 'TransferCancelled';
  }
}

export interface TransferJobContext {
  setTotal(total: number): void;
  advance(steps?: number): void;
  record(outcome: { type: string; slug: string; error?: string | null }): void;
  setError(message: string): void;
  isCancelled(): boolean;
  /** Awaits `promise`, but rejects with `TransferCancelled` the moment the job is cancelled. */
  guard<T>(promise: Promise<T>): Promise<T>;
}

type Listener = () => void;

let state: TransferJobState | null = null;
const listeners = new Set<Listener>();
let cancelListeners = new Set<() => void>();

function emit(next: TransferJobState | null): void {
  state = next;
  listeners.forEach((l) => l());
}

function patch(job: TransferJobState, changes: Partial<TransferJobState>): TransferJobState {
  return { ...job, ...changes };
}

export function subscribeTransferJob(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getTransferJob(): TransferJobState | null {
  return state;
}

export function isTransferRunning(): boolean {
  return state !== null && !state.finished;
}

/** Forgets a finished job (the page's "dismiss"); a running one is never dropped. */
export function clearTransferJob(): void {
  if (state && state.finished) emit(null);
}

/** Abruptly stops the running job: whatever is in flight is abandoned and nothing more starts. */
export function cancelTransferJob(): void {
  if (!state || state.finished || state.cancelled) return;
  emit(patch(state, { cancelled: true }));
  const pending = cancelListeners;
  cancelListeners = new Set();
  pending.forEach((fn) => fn());
}

/**
 * Starts a job. Returns false (and starts nothing) while another is running, so
 * two runs can never interleave their progress.
 */
export function startTransferJob(
  operation: TransferOperation,
  run: (ctx: TransferJobContext) => Promise<void>,
): boolean {
  if (isTransferRunning()) return false;
  cancelListeners = new Set();
  emit({ operation, done: 0, total: 0, finished: false, cancelled: false, summary: emptySummary(), error: null });

  const update = (fn: (job: TransferJobState) => TransferJobState): void => {
    if (state && !state.finished) emit(fn(state));
  };
  const ctx: TransferJobContext = {
    setTotal: (total) => update((j) => patch(j, { total })),
    advance: (steps = 1) => update((j) => patch(j, { done: j.done + steps })),
    record: (outcome) => update((j) => patch(j, { summary: recordOutcome(j.summary, outcome) })),
    setError: (message) => update((j) => patch(j, { error: message })),
    isCancelled: () => state?.cancelled === true,
    guard: <T,>(promise: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        if (state?.cancelled) { reject(new TransferCancelled()); return; }
        const onCancel = (): void => reject(new TransferCancelled());
        cancelListeners.add(onCancel);
        promise.then(
          (value) => { cancelListeners.delete(onCancel); resolve(value); },
          (err) => { cancelListeners.delete(onCancel); reject(err); },
        );
      }),
  };

  void run(ctx)
    .catch((err) => {
      if (!(err instanceof TransferCancelled)) throw err;
    })
    .catch((err) => {
      ctx.setError(err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      if (!state) return;
      emit(patch(state, { finished: true, done: state.cancelled ? state.done : state.total }));
    });
  return true;
}

/** Test hook: drops any job and listener so a test starts clean. */
export function resetTransferJobForTests(): void {
  state = null;
  cancelListeners = new Set();
  listeners.clear();
}
