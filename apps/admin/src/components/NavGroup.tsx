'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CSSProperties } from 'react';
import { NavGroup as NavGroupType, NavItem as NavItemType } from '@/config/navigationGroups';

interface NavGroupProps {
  group: NavGroupType;
  label: string;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  isAnyChildActive: boolean;
}

export function NavGroup({
  group,
  label,
  isExpanded,
  onToggle,
  onNavigate,
  isAnyChildActive,
}: NavGroupProps) {
  const pathname = usePathname();
  const t = useTranslations();

  function renderNavItem(item: NavItemType) {
    const active = pathname === item.href;
    const isParentOfActive = !!item.children && pathname.startsWith(item.href);

    return (
      <div key={item.href}>
        {item.separatorAbove && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '6px 16px' }} />
        )}
        <Link
          href={item.href}
          onClick={onNavigate}
          style={{
            display: 'block',
            padding: '10px 20px',
            color: active ? '#fff' : 'rgba(255,255,255,0.6)',
            textDecoration: 'none',
            background: active && !isParentOfActive ? 'rgba(255,255,255,0.1)' : 'transparent',
            borderLeft: active && !isParentOfActive ? '3px solid var(--brand, #6c63ff)' : '3px solid transparent',
            fontWeight: active ? 600 : 400,
            fontSize: 15,
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

  function renderChildNavItem(item: NavItemType) {
    const active = pathname === item.href;
    const isParentOfActive = !!item.children && pathname.startsWith(item.href);

    return (
      <div key={item.href}>
        <Link
          href={item.href}
          onClick={onNavigate}
          style={{
            display: 'block',
            padding: '8px 20px 8px 36px',
            color: active ? '#fff' : 'rgba(255,255,255,0.6)',
            textDecoration: 'none',
            background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
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
          marginTop: '8px',
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

      <div style={groupContainerStyle}>
        {group.items.map((item) => renderNavItem(item))}
      </div>
    </div>
  );
}
