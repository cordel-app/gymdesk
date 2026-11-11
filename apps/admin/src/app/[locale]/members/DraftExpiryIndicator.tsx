'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDraftRemaining, isDraftWarning, remainingNow } from './draftCountdown';

/**
 * #2477 — compact, secondary "Draft expires in 1h 45m". Counts down locally from
 * the server's seconds and calls `onExpire` once at zero so the section re-reads
 * the (now discarded) Draft instead of leaving it editable.
 */
export function DraftExpiryIndicator({ seconds, onExpire }: {
  seconds: number | null | undefined; onExpire?: () => void;
}) {
  const t = useTranslations('members');
  const receivedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  const fired = useRef(false);

  useEffect(() => { receivedAt.current = Date.now(); setNow(Date.now()); fired.current = false; }, [seconds]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const left = seconds == null ? null : remainingNow(seconds, receivedAt.current, now);
  useEffect(() => {
    if (left === 0 && !fired.current) { fired.current = true; onExpire?.(); }
  }, [left, onExpire]);

  const text = formatDraftRemaining(left);
  if (text == null) return null;
  const warn = left != null && isDraftWarning(left);
  const exact = warn ? new Date(Date.now() + (left as number) * 1000).toLocaleTimeString() : null;
  return (
    <span data-draft-expiry style={{ fontSize: 12, opacity: 0.85, fontWeight: warn ? 600 : 400, color: warn ? 'var(--gd-warning, #b45309)' : undefined }}>
      {t('draft_expires_in')} {text}{exact ? ` (${exact})` : ''}
    </span>
  );
}
