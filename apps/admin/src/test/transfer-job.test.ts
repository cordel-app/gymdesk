// #2952: the Export / Import job outlives the page that started it, reports its
// progress to whoever looks, and Cancel stops it at once.
import { afterEach, describe, expect, it } from 'vitest';
import {
  TransferCancelled,
  cancelTransferJob,
  clearTransferJob,
  getTransferJob,
  resetTransferJobForTests,
  startTransferJob,
  subscribeTransferJob,
} from '../lib/transferJob';

afterEach(resetTransferJobForTests);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('transfer job', () => {
  it('keeps its progress for a late subscriber and finishes at 100%', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    startTransferJob('import', async (ctx) => {
      ctx.setTotal(2);
      ctx.advance();
      await ctx.guard(gate);
      ctx.record({ type: 'muscles', slug: 'a' });
      ctx.advance();
    });
    // a page that mounts later reads the live state
    expect(getTransferJob()).toMatchObject({ operation: 'import', done: 1, total: 2, finished: false });
    release();
    await tick();
    expect(getTransferJob()).toMatchObject({ done: 2, finished: true, cancelled: false });
    expect(getTransferJob()?.summary.succeeded).toBe(1);
  });

  it('refuses a second job while one runs', () => {
    const never = new Promise<void>(() => {});
    expect(startTransferJob('export', () => never)).toBe(true);
    expect(startTransferJob('import', async () => {})).toBe(false);
  });

  it('cancel abandons the call in flight and starts nothing more', async () => {
    const never = new Promise<void>(() => {});
    let afterGuard = false;
    startTransferJob('export', async (ctx) => {
      await ctx.guard(never);
      afterGuard = true;
    });
    cancelTransferJob();
    await tick();
    expect(afterGuard).toBe(false);
    expect(getTransferJob()).toMatchObject({ finished: true, cancelled: true, error: null });
  });

  it('records an unexpected failure as the job error and notifies subscribers', async () => {
    let notified = 0;
    subscribeTransferJob(() => { notified += 1; });
    startTransferJob('export', async () => { throw new Error('boom'); });
    await tick();
    expect(getTransferJob()?.error).toBe('boom');
    expect(notified).toBeGreaterThan(1);
    clearTransferJob();
    expect(getTransferJob()).toBeNull();
  });

  it('only clears a finished job', () => {
    startTransferJob('export', () => new Promise<void>(() => {}));
    clearTransferJob();
    expect(getTransferJob()).not.toBeNull();
    expect(new TransferCancelled().name).toBe('TransferCancelled');
  });
});
