'use client';

import React, { createContext, useContext, useMemo, useState } from 'react';

/**
 * #2224 — the day hovered (or focused) in a goal's Reading History, shared with its chart
 * so the chart can highlight that day's point and draw the informative flag, as the
 * Progress tab's exercise charts do. A day is a `YYYY-MM-DD` key; outside a provider the
 * hook is inert, so a host that renders only one of the two components is unaffected.
 */
interface HoverState { day: string | null; setDay: (day: string | null) => void }
const NONE: HoverState = { day: null, setDay: () => {} };
const Ctx = createContext<HoverState>(NONE);

export function GoalReadingHoverProvider({ children }: { children: React.ReactNode }) {
  const [day, setDay] = useState<string | null>(null);
  const value = useMemo(() => ({ day, setDay }), [day]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGoalReadingHover(): HoverState {
  return useContext(Ctx);
}
