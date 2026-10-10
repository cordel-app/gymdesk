'use client';

import { createElement, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '@/context/AppContext';
import { sectionCardBorder, sectionCardShape, sectionCardText } from '@/lib/memberChrome';
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
 *
 * The border is the theme's (#833 §4: the Section Cards Border Colour and
 * Width, each inheriting from the Admin Card Border until the Theme overrides
 * it), and since #983 it is `sectionCardBorder` in `lib/memberChrome.ts` — the
 * one place the Members App spells a visual value, so the content cards of the
 * sections this component does not wrap carry the same border rather than a
 * second copy of the rule.
 *
 * The text inside it is the theme's too (#1152 §3/§4): `sectionCardText`
 * carries the Section Cards text colour, size and font and the two positions,
 * spread **under** the caller's style so a tile that spells none of them takes
 * all five, while a card whose body is a structure of its own keeps what it
 * spells. The artwork, the dimensions, the behaviour and the navigation are
 * the caller's and untouched, and the positioning works over the fallback
 * colour because the box is the same with or without an image.
 */
export function MembersSectionCard({ slot, as = 'div', style, children, ...rest }: MembersSectionCardProps) {
  const background = useSectionBackground(slot);
  return createElement(
    as,
    {
      ...(as === 'button' ? { type: 'button' as const } : {}),
      ...rest,
      style: { ...sectionCardText, ...style, ...(background ? { background } : {}), ...sectionCardShape, ...sectionCardBorder },
    },
    children,
  );
}
