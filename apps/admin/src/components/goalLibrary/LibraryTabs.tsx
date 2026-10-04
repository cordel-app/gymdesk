'use client';

import React from 'react';
import { Tabs } from '@/components/Tabs';
import { LIBRARY_TABS, LibraryTabId } from './goalProfile';

/**
 * #947 §1/§2/§6 — the Nutrition Library's tabs: Foods and Nutrition Goals.
 *
 * One component for both libraries (a gym's and Cordel's Base one), so the pair
 * cannot offer different tabs or a different order — which tabs exist is
 * `LIBRARY_TABS` in `goalProfile.ts`, never this JSX. Switching tabs changes the
 * content and the available actions in place; it is deliberately not a route, so
 * the page's own state (a gym's active gym, a list already loaded) survives.
 *
 * #961 — the strip itself is the app's shared `Tabs`, promoted out of this file
 * when the Member card needed the same one: there is one tab look, one set of
 * tab semantics and one keyboard implementation in the admin app. This module
 * is what binds it to `LIBRARY_TABS`.
 *
 * The labels stay the page's: it is handed a `label` resolver so each library
 * translates in its own namespace, the way every other shared component here
 * does (#901).
 */
export function LibraryTabs({ active, onChange, label }: {
  active: LibraryTabId;
  onChange: (tab: LibraryTabId) => void;
  label: (key: string) => string;
}) {
  return <Tabs tabs={LIBRARY_TABS} active={active} onChange={onChange} label={label} />;
}
