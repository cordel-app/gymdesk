// A process-wide bound on how many pictures are decoded and encoded at once
// (#1449, shared with the exercise media since #1420). Decoding is CPU- and
// memory-heavy; two at a time keeps one burst of uploads from starving the rest
// of the API, whichever feature they came from.

const MAX_CONCURRENT = 2;
let active = 0;
const waiting: Array<() => void> = [];

export async function withImageProcessingSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}
