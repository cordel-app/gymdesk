'use client';

import React from 'react';
import { getCalendarEventStatusBadgeColors } from '@/lib/calendarEventColors';

/**
 * #559 stage 3 — the pill-shaped status indicator rendered inside a calendar
 * event.
 *
 * Since the event box itself now takes its background from the theme's
 * Calendar tokens (one color for every event), this badge is what tells the
 * statuses apart — the role the event's fill played before (#541). Its colors
 * come from the same centralized status mapping and depend on nothing else.
 *
 * Deliberately not the app's `StatusBadge`: that one is sized for table cells
 * and detail panels. This is the same shape and palette at the font size a
 * calendar event can afford, and shrinks further in month view, where an event
 * is a single line.
 */
export function CalendarStatusBadge({
  status,
  label,
  compact = false,
}: {
  status: string;
  label: string;
  compact?: boolean;
}) {
  const c = getCalendarEventStatusBadgeColors(status);
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        borderRadius: 999,
        padding: compact ? '0 6px' : '1px 8px',
        fontSize: compact ? 9 : 10,
        lineHeight: compact ? '14px' : '16px',
        fontWeight: 700,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        display: 'inline-block',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {label}
    </span>
  );
}
