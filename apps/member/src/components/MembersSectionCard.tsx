'use client';

import { createElement, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '@/context/AppContext';
import { DEFAULT_TOKENS } from '@/lib/themeTokens';
import {
  CARD_SCRIM_ALPHA,
  backgroundUrlForSlot,
  cardBackgroundStyleValue,
  hexToRgba,
  type MemberBackgroundSlot,
} from '@/lib/membersBackground';

/**
 * #728: the active theme's artwork for one Members section, as a CSS
 * `background` value — or `null` when the theme does not configure that slot.
 *
 * The Members App consumes *resolved URLs only* (#725): it reads
 * `theme.members_images`, which the API has already resolved from the Customer
 * Theme, and resolves nothing further itself — no storage path, no second
 * theme, no asset of its own. A slot that is `null` means the card keeps the
 * plain surface it has today, and that is the end of the rule.
 *
 * The scrim is the theme's own card colour at partial opacity, the same
 * treatment `MembersBackground` gives the page, so a dark theme darkens and a
 * light theme lightens and every card reads the same way.
 */
export function useSectionBackground(slot: MemberBackgroundSlot): string | null {
  const { theme } = useApp();
  const url = backgroundUrlForSlot(theme?.members_images ?? null, slot);
  const surface = (theme?.tokens as any)?.colors?.cardBackground ?? DEFAULT_TOKENS.colors.cardBackground;
  return cardBackgroundStyleValue(url, hexToRgba(surface, CARD_SCRIM_ALPHA));
}

interface MembersSectionCardProps {
  /** Which of the six Members App images belongs to this surface. */
  slot: MemberBackgroundSlot;
  /** The element to render — the card's existing one, never a new wrapper. */
  as?: 'div' | 'button';
  style?: CSSProperties;
  onClick?: () => void;
  role?: string;
  tabIndex?: number;
  'aria-label'?: string;
  children: ReactNode;
}

/**
 * A Members surface that paints its section's background image behind its
 * existing content (#728).
 *
 * It renders the element the caller already rendered, with the caller's own
 * styles, and only replaces the `background` when the theme configures that
 * slot — so the layout, the grid, the card dimensions, the icons, the labels
 * and the navigation are untouched, which is what the ticket asks of it. The
 * image is background artwork, not an `<img>`: decorative, so it carries no
 * alt text and reaches no screen reader, and it sits behind the content
 * rather than in the tab order.
 */
export function MembersSectionCard({ slot, as = 'div', style, children, ...rest }: MembersSectionCardProps) {
  const background = useSectionBackground(slot);
  return createElement(
    as,
    {
      ...(as === 'button' ? { type: 'button' as const } : {}),
      ...rest,
      style: background ? { ...style, background } : style,
    },
    children,
  );
}
