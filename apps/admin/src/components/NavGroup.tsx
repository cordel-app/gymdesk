'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CSSProperties, useState } from 'react';
import { NavGroup as NavGroupType, NavItem as NavItemType } from '@/config/navigationGroups';

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
}

export function NavGroup({
  group,
  label,
  isExpanded,
  onToggle,
  onNavigate,
  isAnyChildActive,
  badge,
}: NavGroupProps) {
  const showBadge = !!badge && badge.count > 0;
  const pathname = usePathname();
  const t = useTranslations();
  const [hoveredHref, setHoveredHref] = useState<string | null>(null);

  function renderNavItem(item: NavItemType) {
    const active = pathname === item.href;
    const isParentOfActive = !!item.children && pathname.startsWith(item.href);
    const hovered = hoveredHref === item.href && !active;

    return (
      <div key={item.href}>
        {item.separatorAbove && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '6px 16px' }} />
        )}
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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginTop: '8px' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          padding: '10px 20px',
          background: 'transparent',
          border: 'none',
          color: 'rgba(255,255,255,0.6)',
          textDecoration: 'none',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          gap: '8px',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '16px',
            height: '16px',
            transition: 'transform 150ms ease-in-out',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
        {label}
      </button>
      {showBadge && (
        <span style={{ paddingRight: 16 }}><Badge badge={badge!} onNavigate={onNavigate} /></span>
      )}
      </div>

      <div style={groupContainerStyle}>
        {group.items.map((item) => renderNavItem(item))}
      </div>
    </div>
  );
}
