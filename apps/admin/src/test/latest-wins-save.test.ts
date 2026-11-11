import { describe, expect, it } from 'vitest';
import { createLatestWinsSaver } from '@/lib/latestWinsSave';

// #2661: meal ingredients persist on every change, so rapid edits must never
// let an older request land after (and overwrite) a newer one.

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createLatestWinsSaver', () => {
  it('sends one request at a time and only the newest waiting value next', async () => {
    const sent: number[] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const succeeded: number[] = [];
    const saver = createLatestWinsSaver<number>(
      (v) => { sent.push(v); const d = deferred(); gates.push(d); return d.promise; },
      { onSuccess: (v) => succeeded.push(v) },
    );

    const first = saver.save(1);
    saver.save(2);
    saver.save(3);
    expect(sent).toEqual([1]);
    expect(saver.busy()).toBe(true);

    gates[0].resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(sent).toEqual([1, 3]);
    expect(succeeded).toEqual([]); // 1 was superseded

    gates[1].resolve();
    await first;
    expect(succeeded).toEqual([3]);
    expect(saver.busy()).toBe(false);
  });

  it('reports a failure of the newest value and keeps it, so it can be retried', async () => {
    const errors: number[] = [];
    const saver = createLatestWinsSaver<number>(
      async () => { throw new Error('boom'); },
      { onError: (_e, v) => errors.push(v) },
    );
    await saver.save(7);
    expect(errors).toEqual([7]);
    expect(saver.busy()).toBe(false);
  });

  it('a failed older value superseded by a newer one is not reported', async () => {
    const errors: number[] = [];
    const succeeded: number[] = [];
    const gate = deferred();
    let calls = 0;
    const saver = createLatestWinsSaver<number>(
      (v) => { calls += 1; return calls === 1 ? gate.promise : Promise.resolve(); },
      { onError: (_e, v) => errors.push(v), onSuccess: (v) => succeeded.push(v) },
    );
    const done = saver.save(1);
    saver.save(2);
    gate.reject(new Error('stale failure'));
    await done;
    expect(errors).toEqual([]);
    expect(succeeded).toEqual([2]);
  });
});
