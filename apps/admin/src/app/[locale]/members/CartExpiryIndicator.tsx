'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDraftRemaining, isDraftWarning, remainingNow, showsDraftExactTime } from './draftCountdown';

/**
 * #2477 — compact, secondary countdown. Counts down locally from the server's
 * seconds and calls `onExpire` once at zero so the tab re-reads the (now
 * discarded) cart instead of leaving it editable.
 *
 * #3274 follow-up — it is the **cart's** countdown ("Cart expires in 1h 45m"),
 * shown once beside the cart's In Cart status in the Summary, never on the
 * Product Set header: the clock is the purchase's `expires_at`. Since #3378 it
 * sits in the Purchase header ("Expires in 1h 45m"), right after the status badge.
 */
export function CartExpiryIndicator({ seconds, onExpire, labelKey = 'cart_expires_in' }: {
  seconds: number | null | undefined; onExpire?: () => void;
  /** #3307 stage 4 — `payment_expires_in` for a purchase awaiting payment (its 24 hours). */
  labelKey?: 'cart_expires_in' | 'payment_expires_in';
}) {
  const t = useTranslations('members');
  const receivedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  const fired = useRef(false);

  useEffect(() => { receivedAt.current = Date.now(); setNow(Date.now()); fired.current = false; }, [seconds]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const left = seconds == null ? null : remainingNow(seconds, receivedAt.current, now);
  useEffect(() => {
    if (left === 0 && !fired.current) { fired.current = true; onExpire?.(); }
  }, [left, onExpire]);

  const text = formatDraftRemaining(left);
  if (text == null) return null;
  const warn = left != null && isDraftWarning(left);
  const exact = left != null && showsDraftExactTime(left) ? new Date(Date.now() + (left as number) * 1000).toLocaleTimeString() : null;
  return (
    <span data-cart-expiry style={{ fontSize: 12, opacity: 0.85, fontWeight: warn ? 600 : 400, color: warn ? 'var(--gd-warning, #b45309)' : undefined }}>
      {t(labelKey)} {text}{exact ? ` (${exact})` : ''}
    </span>
  );
}
