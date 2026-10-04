'use client';

import { createElement, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '@/context/AppContext';
import {
  backgroundUrlForSlot,
  cardBackgroundStyleValue,
  type MemberBackgroundSlot,
} from '@/lib/membersBackground';

/**
 * #728: the artwork the active theme configures for one Members section, as a
 * resolved URL — or `null` when the theme does not configure that slot.
 *
 * The Members App consumes *resolved URLs only* (#725): it reads
 * `theme.members_images`, which the API has already resolved from the Customer
 * Theme, and resolves nothing further itself — no storage path, no second
 * theme, no asset of its own. A slot that is `null` means the surface keeps
 * what it has today, and that is the end of the rule.
 *
 * It is exported because #982 makes one more thing depend on the same answer:
 * a tile with artwork **replaces** its default icon rather than layering it
 * over the picture, so the tile asks this hook instead of testing
 * `theme.members_images` for itself.
 */
export function useSectionImageUrl(slot: MemberBackgroundSlot): string | null {
  const { theme } = useApp();
  return backgroundUrlForSlot(theme?.members_images ?? null, slot);
}

/**
 * The same artwork as a CSS `background` value, or `null` for an unconfigured
 * slot.
 *
 * Since #982 it carries **no scrim**: the uploaded image is the card's primary
 * visual and is painted at full opacity, with its own colours and contrast
 * intact. The page background keeps its scrim (`MembersBackground`), because
 * that one surface sits under every page's text and controls at once.
 */
export function useSectionBackground(slot: MemberBackgroundSlot): string | null {
  return cardBackgroundStyleValue(useSectionImageUrl(slot));
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
      style: { ...style, ...(background ? { background } : {}), ...SECTION_CARD_BORDER },
    },
    children,
  );
}

/**
 * #833 §4 — a Section Card's border, from the theme. The colour and the width
 * are two Members App settings of their own, each inheriting from the Admin
 * Card Border / Card Border Width until the Theme overrides it
 * (lib/membersAppTokens.ts writes both variables).
 *
 * It lives here rather than on the pages because "Section Card" is exactly what
 * this component is: every navigation card the ticket names renders through it,
 * and nothing else does, so one rule covers all of them and reaches no other
 * surface.
 */
const SECTION_CARD_BORDER = {
  borderStyle: 'solid',
  borderColor: 'var(--gd-members-card-border, var(--gd-card-border, #e5e7eb))',
  borderWidth: 'var(--gd-members-card-border-width, 1px)',
} as const;
