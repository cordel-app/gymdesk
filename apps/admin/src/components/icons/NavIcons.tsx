'use client';

import { ComponentType, ReactNode } from 'react';
import { NAV_ICON_SIZE, NAV_ICON_STROKE, NavIconName } from './navIconNames';

/**
 * #884: the sidebar's first-level icon set.
 *
 * One coherent set, not nine individually designed drawings: every icon is drawn
 * on the same 24×24 grid through the single `IconShell` below, so the stroke
 * width, the joins, the size and the colour are declared once. The stroke is
 * `currentColor` and nothing is filled, which is what makes the icons follow the
 * navigation item's own active / hover / focus colour instead of carrying a
 * second visual state of their own.
 *
 * They are decorative — the accessible name of a nav item is still its label —
 * so each `<svg>` is `aria-hidden` and outside the tab order.
 *
 * No icon library is installed in `apps/admin` (see `package.json`): for nine
 * icons a dependency costs more than it saves, and these components follow the
 * app's existing "inline styles, no UI framework" shape.
 */

export interface NavIconProps {
  /** Defaults to NAV_ICON_SIZE; the sidebar never overrides it. */
  size?: number;
}

export type NavIconComponent = ComponentType<NavIconProps>;

function IconShell({ size = NAV_ICON_SIZE, children }: NavIconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={NAV_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

/** Membership — two people. */
export function UsersIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <circle cx="9" cy="7.5" r="3.5" />
      <path d="M2.5 20.5v-1.2a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5v1.2" />
      <path d="M16.5 4.4a3.5 3.5 0 0 1 0 6.2" />
      <path d="M18 14.9a4.5 4.5 0 0 1 3.5 4.4v1.2" />
    </IconShell>
  );
}

/** Calendar — a month sheet with two hangers. */
export function CalendarIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M8 2.5v4" />
      <path d="M16 2.5v4" />
      <path d="M3 10h18" />
    </IconShell>
  );
}

/** Organization — a building with an annex. */
export function BuildingIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
      <path d="M14 11h4a2 2 0 0 1 2 2v8" />
      <path d="M2.5 21h19" />
      <path d="M8 7.5h2" />
      <path d="M8 12h2" />
      <path d="M8 16.5h2" />
    </IconShell>
  );
}

/** Training — a dumbbell. */
export function DumbbellIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <rect x="2.5" y="8" width="4" height="8" rx="1.3" />
      <rect x="17.5" y="8" width="4" height="8" rx="1.3" />
      <path d="M6.5 12h11" />
    </IconShell>
  );
}

/** Nutrition — an apple with its stem. */
export function AppleIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <path d="M12 9c-1.5-1.6-3.3-2.2-5-1.4C4.9 8.6 4 11 4 13.4 4 17.5 7.3 21 11 21h2c3.7 0 7-3.5 7-7.6 0-2.4-.9-4.8-3-5.8-1.7-.8-3.5-.2-5 1.4Z" />
      <path d="M12 9V6.6A2.6 2.6 0 0 1 14.6 4" />
    </IconShell>
  );
}

/** Payments — a card with its stripe. */
export function CreditCardIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
      <path d="M6 14.5h4" />
    </IconShell>
  );
}

/** Financials — a banknote: the money catalogue rather than a single payment. */
export function BanknoteIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M5.5 10.5v3" />
      <path d="M18.5 10.5v3" />
    </IconShell>
  );
}

/** Configuration — sliders: legible at 16px where a gear's teeth are not. */
export function SlidersIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <path d="M3.5 7.5h8" />
      <path d="M16.5 7.5h4" />
      <circle cx="14" cy="7.5" r="2.5" />
      <path d="M3.5 16.5h4" />
      <path d="M12.5 16.5h8" />
      <circle cx="10" cy="16.5" r="2.5" />
    </IconShell>
  );
}

/** Cordel — a shield: the platform-wide, superadmin-only area. */
export function ShieldIcon(props: NavIconProps) {
  return (
    <IconShell {...props}>
      <path d="M12 2.5 4 5.8v5.4c0 4.6 3.3 8.3 8 9.8 4.7-1.5 8-5.2 8-9.8V5.8Z" />
    </IconShell>
  );
}

/**
 * The one mapping from a name to its drawing. `config/navigationGroups.ts` names
 * the icon; nothing branches on a group id or a label to choose one.
 */
export const NAV_ICONS: Record<NavIconName, NavIconComponent> = {
  users: UsersIcon,
  calendar: CalendarIcon,
  building: BuildingIcon,
  dumbbell: DumbbellIcon,
  apple: AppleIcon,
  creditCard: CreditCardIcon,
  banknote: BanknoteIcon,
  sliders: SlidersIcon,
  shield: ShieldIcon,
};

/** Renders the named icon. Unknown names cannot occur — `NavIconName` is a union. */
export function NavIcon({ name, size }: { name: NavIconName; size?: number }) {
  const Icon = NAV_ICONS[name];
  return <Icon size={size} />;
}
