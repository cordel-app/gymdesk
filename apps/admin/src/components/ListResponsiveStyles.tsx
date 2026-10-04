'use client';

import { LIST_RESPONSIVE_CSS } from './listChrome';

/**
 * #1011 — the one place a list's mobile rules reach the document.
 *
 * `AppShell` renders it once, so every list on every screen is narrowed by the
 * same sheet. It carries no rules of its own: what the classes mean is declared
 * beside the rest of a list's chrome (`listChrome.ts`, #724), and a page that
 * spelled a media query for itself would be the second place deciding what a
 * phone shows.
 */
export function ListResponsiveStyles() {
  return <style>{LIST_RESPONSIVE_CSS}</style>;
}
