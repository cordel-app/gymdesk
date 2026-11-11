'use client';

import { useEffect, useRef, useState } from 'react';
import { remainingNow } from './draftCountdown';

/** How often the countdown re-renders; minutes are its smallest unit. */
const TICK_MS = 15_000;

/**
 * #2477 stage 3 — the live remaining seconds of a Draft, counted down locally
 * from the server's value and re-based every time the server answers a new one.
 * `onExpire` runs once when it reaches zero so the page re-reads the (now
 * expired) Draft instead of leaving it editable. `null` without a countdown.
 */
export function useDraftCountdown(serverSeconds: number | null | undefined, onExpire?: () => void): number | null {
  const receivedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    receivedAt.current = Date.now();
    setNow(Date.now());
    fired.current = false;
  }, [serverSeconds]);

  useEffect(() => {
    if (serverSeconds == null) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [serverSeconds]);

  const left = serverSeconds == null || !Number.isFinite(Number(serverSeconds))
    ? null
    : remainingNow(Number(serverSeconds), receivedAt.current, now);

  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      expireRef.current?.();
    }
  }, [left]);

  return left;
}
