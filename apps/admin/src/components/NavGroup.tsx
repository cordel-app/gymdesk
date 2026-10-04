'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CSSProperties, useState } from 'react';
import { NavGroup as NavGroupType, NavItem as NavItemType } from '@/config/navigationGroups';
import { NavIcon } from './icons/NavIcons';
import { navGroupSeparatorStyle, navItemSeparatorStyle } from './navChrome';

/**
 * #779: a count shown beside the group header and beside one of its items,
 * linking to the page where the counted rows are worked through.
 */
export interface NavBadge {
  count: number;
  /** Where clicking the badge goes (a filtered list, not the item's own page). */
  href: string;
  /** The item (already locale-resolved href) the badge sits beside. */
  itemHref: string;
  /** Accessible name, e.g. "3 failed payments awaiting action". */
  label: string;
}

function Badge({ badge, onNavigate }: { badge: NavBadge; onNavigate?: () => void }) {
  return (
    <Link
      href={badge.href}
      onClick={onNavigate}
      aria-label={badge.label}
      title={badge.label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10,
        background: '#dc2626', color: '#fff', fontSize: 12, fontWeight: 700,
        lineHeight: 1, textDecoration: 'none', flexShrink: 0,
      }}
    >
      {badge.count > 99 ? '99+' : badge.count}
    </Link>
  );
}

interface NavGroupProps {
  group: NavGroupType;
  label: string;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  isAnyChildActive: boolean;
  /** Hidden when absent or zero. */
  badge?: NavBadge | null;
  /**
   * #1003: the desktop sidebar is collapsed to icons only. The header button
   * then renders its icon alone — no chevron, no label, no items underneath —
   * and carries the active treatment when the open page is inside this group,
   * because the active subsection that would carry it is no longer on screen.
   * `onToggle` is what the sidebar wires to "expand me again and open this
   * group" in that mode: a collapsed section is not a page of its own (§2).
   */
  collapsed?: boolean;
  /**
   * #1020: the heavier rule above this section, declared on the group itself
   * (`NavGroup.separatorAbove`) and switched off by the sidebar for the first
   * visible section, which has nothing above it to be separated from.
   */
  separatorAbove?: boolean;
}

export function NavGroup({
  group,
  label,
  isExpanded,
  onToggle,
  onNavigate,
  isAnyChildActive,
  badge,
  collapsed = false,
  separatorAbove = false,
}: NavGroupProps) {
  const showBadge = !!badge && badge.count > 0;
  const pathname = usePathname();
  const t = useTranslations();
  const [hoveredHref, setHoveredHref] = useState<string | null>(null);
  // Only read while collapsed: expanded mode keeps the header exactly as it was
  // (#1003 §1 — "Expanded mode preserves the current look & feel").
  const [headerHovered, setHeaderHovered] = useState(false);

  function renderNavItem(item: NavItemType) {
    const active = pathname === item.href;
    const isParentOfActive = !!item.children && pathname.startsWith(item.href);
    const hovered = hoveredHref === item.href && !active;

    return (
      <div key={item.href}>
        {item.separatorAbove && <div style={navItemSeparatorStyle} />}
        <div style={{ display: 'flex', alignItems: 'center' }}>
        <Link
          href={item.href}
          onClick={onNavigate}
          onMouseEnter={() => setHoveredHref(item.href)}
          onMouseLeave={() => setHoveredHref(null)}
          style={{
            display: 'block',
            flex: 1,
            padding: '10px 20px',
            color: active ? 'var(--gd-sidebar-selected-text, #fff)' : 'var(--gd-sidebar-text, rgba(255,255,255,0.6))',
            textDecoration: 'none',
            background: active && !isParentOfActive
              ? 'var(--gd-sidebar-selected-bg, rgba(255,255,255,0.1))'
              : hovered ? 'var(--gd-sidebar-hover-bg, rgba(255,255,255,0.08))' : 'transparent',
            borderLeft: active && !isParentOfActive ? '3px solid var(--brand, #6c63ff)' : '3px solid transparent',
            fontWeight: active ? 600 : 400,
            fontSize: 15,
          }}
        >
          {t(item.labelKey as any)}
        </Link>
        {showBadge && badge!.itemHref === item.href && (
          <span style={{ paddingRight: 16 }}><Badge badge={badge!} onNavigate={onNavigate} /></span>
        )}
        </div>

        {item.children && isParentOfActive && (
          <div>
            {item.children.map((child) => renderChildNavItem(child))}
          </div>
        )}
      </div>
    );
  }

  function renderChildNavItem(item: NavItemType) {
    const active = pathname === item.href;
    const isParentOfActive = !!item.children && pathname.startsWith(item.href);
    const hovered = hoveredHref === item.href && !active;

    return (
      <div key={item.href}>
        <Link
          href={item.href}
          onClick={onNavigate}
          onMouseEnter={() => setHoveredHref(item.href)}
          onMouseLeave={() => setHoveredHref(null)}
          style={{
            display: 'block',
            padding: '8px 20px 8px 36px',
            color: active ? 'var(--gd-sidebar-selected-text, #fff)' : 'var(--gd-sidebar-text, rgba(255,255,255,0.6))',
            textDecoration: 'none',
            background: active
              ? 'var(--gd-sidebar-selected-bg, rgba(255,255,255,0.1))'
              : hovered ? 'var(--gd-sidebar-hover-bg, rgba(255,255,255,0.08))' : 'transparent',
            borderLeft: active ? '3px solid var(--brand, #6c63ff)' : '3px solid transparent',
            fontWeight: active ? 600 : 400,
            fontSize: 14,
          }}
        >
          {t(item.labelKey as any)}
        </Link>

        {item.children && isParentOfActive && (
          <div>
            {item.children.map((child) => renderChildNavItem(child))}
          </div>
        )}
      </div>
    );
  }

  const groupContainerStyle: CSSProperties = {
    overflow: 'hidden',
    maxHeight: isExpanded ? '1000px' : '0px',
    transition: 'max-height 150ms ease-in-out',
  };

  // #1003 §2/§4: collapsed, the parent icon stands in for the active subsection
  // and takes the treatment an active navigation item already has — the same
  // selected background, text colour and 3px brand rail, no new colour.
  const showActiveParent = collapsed && isAnyChildActive;

  return (
    <div>
      {/* #1020: above the header, so it separates this section from the one
          before it in both modes — the collapsed strip keeps the rule and only
          narrows its inset (navChrome). */}
      {separatorAbove && <div style={navGroupSeparatorStyle(collapsed)} />}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: '8px', position: 'relative' }}>
      <button
        onClick={onToggle}
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
        // Collapsed, the label is the only thing naming the section, so it is
        // both the tooltip (§4) and the accessible name — the icon beside it is
        // decorative and `aria-hidden`. Expanded, the label is on screen and
        // repeating it as a title would just shadow it.
        title={collapsed ? label : undefined}
        aria-label={collapsed ? label : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          width: '100%',
          boxSizing: 'border-box',
          // #884: 16px rather than 20px, and a 6px gap rather than 8px, so the
          // section icon fits beside the chevron without the longest uppercase
          // label ("CONFIGURACIÓN", "ENTRENAMIENTO") wrapping onto a second line
          // in the 220px sidebar. Nothing else about the header's spacing moves.
          padding: '10px 16px',
          // #1003: collapsed, the icon is the whole button, so it centres in
          // the strip rather than sitting at #884's label inset. The expanded
          // spacing above is untouched — this only overrides it.
          ...(collapsed ? { padding: '10px 0' } : null),
          background: showActiveParent
            ? 'var(--gd-sidebar-selected-bg, rgba(255,255,255,0.1))'
            : collapsed && headerHovered
              ? 'var(--gd-sidebar-hover-bg, rgba(255,255,255,0.08))'
              : 'transparent',
          border: 'none',
          borderLeft: showActiveParent
            ? '3px solid var(--brand, #6c63ff)'
            : '3px solid transparent',
          color: showActiveParent
            ? 'var(--gd-sidebar-selected-text, #fff)'
            : 'rgba(255,255,255,0.6)',
          textDecoration: 'none',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          gap: '6px',
          whiteSpace: 'nowrap',
        }}
      >
        {!collapsed && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '16px',
              height: '16px',
              flexShrink: 0,
              transition: 'transform 150ms ease-in-out',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▶
          </span>
        )}
        {/*
          #884: the section's own icon, beside — never instead of — the chevron:
          the icon identifies the category, the chevron says whether it is open.
          It is decorative and `aria-hidden`, so the button's accessible name is
          still the label, and it draws in `currentColor`, so it follows the
          header's colour rather than carrying a state of its own.

          #1003: collapsed, it is the only thing left in the button — the one
          occurrence, rendered at the one shared size in both modes.
        */}
        <NavIcon name={group.icon} />
        {!collapsed && label}
      </button>
      {showBadge && (
        collapsed
          // #779's attention count survives the collapse: there is no label to
          // sit beside, so it rides the icon's corner rather than disappearing.
          ? (
            <span style={{ position: 'absolute', top: 2, right: 4, lineHeight: 0 }}>
              <Badge badge={badge!} onNavigate={onNavigate} />
            </span>
          )
          : <span style={{ paddingRight: 16 }}><Badge badge={badge!} onNavigate={onNavigate} /></span>
      )}
      </div>

      {!collapsed && (
        <div style={groupContainerStyle}>
          {group.items.map((item) => renderNavItem(item))}
        </div>
      )}
    </div>
  );
}
