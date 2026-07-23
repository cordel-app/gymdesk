'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { navigationGroups, filterNavGroups, NavItem as NavItemType, NavGroup as NavGroupType } from '@/config/navigationGroups';
import { NavGroup } from './NavGroup';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const { isSuperadmin, activeGym } = useGym();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Determine user role for filtering
  const userRole = isSuperadmin ? 'superadmin' : (activeGym?.role ?? 'member');

  // Load expanded state from sessionStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = sessionStorage.getItem('navGroupsExpanded');
    if (saved) {
      try {
        setExpandedGroups(new Set(JSON.parse(saved)));
      } catch (e) {
        // Ignore parse errors
      }
    }
  }, []);

  // Save expanded state to sessionStorage whenever it changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem('navGroupsExpanded', JSON.stringify([...expandedGroups]));
  }, [expandedGroups]);

  // Auto-expand group containing active route
  useEffect(() => {
    const filteredGroups = filterNavGroups(navigationGroups, userRole);

    for (const group of filteredGroups) {
      const hasActiveItem = group.items.some(item =>
        pathname === item.href ||
        (item.children?.some(child => pathname === child.href))
      );

      if (hasActiveItem && !expandedGroups.has(group.id)) {
        setExpandedGroups(prev => new Set(prev).add(group.id));
      }
    }
  }, [pathname, userRole]);

  // Replace {{locale}} placeholder in hrefs
  const replaceLocale = (href: string) => href.replace(/\{\{locale\}\}/g, locale);

  // Translate an item with locale replacement
  const translateItem = (item: NavItemType): NavItemType => ({
    ...item,
    href: replaceLocale(item.href),
    children: item.children?.map(child => translateItem(child)),
  });

  // Translate all groups
  const translatedGroups = filterNavGroups(navigationGroups, userRole).map(group => ({
    ...group,
    items: group.items.map(translateItem),
  }));

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function renderNavItem(item: NavItemType) {
    const active = pathname === item.href;
    const isParentOfActive = !!item.children && pathname.startsWith(item.href);

    return (
      <div key={item.href}>
        <Link
          href={item.href}
          onClick={onNavigate}
          style={{
            display: 'block',
            padding: '10px 20px',
            color: active ? 'var(--gd-sidebar-selected-text, #fff)' : 'var(--gd-sidebar-text, rgba(255,255,255,0.6))',
            textDecoration: 'none',
            background: active && !isParentOfActive ? 'var(--gd-sidebar-selected-bg, rgba(255,255,255,0.1))' : 'transparent',
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
            color: active ? 'var(--gd-sidebar-selected-text, #fff)' : 'var(--gd-sidebar-text, rgba(255,255,255,0.6))',
            textDecoration: 'none',
            background: active ? 'var(--gd-sidebar-selected-bg, rgba(255,255,255,0.1))' : 'transparent',
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

  return (
    <aside style={{
      width: 220,
      background: 'var(--gd-sidebar-bg, var(--chrome, #1a1a2e))',
      color: 'var(--gd-sidebar-text, #fff)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      minHeight: '100vh',
    }}>
      <nav style={{ padding: '12px 0', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {translatedGroups.map(group => {
          const isAnyChildActive = group.items.some(item =>
            pathname === item.href ||
            (item.children?.some(child => pathname === child.href))
          );

          return (
            <NavGroup
              key={group.id}
              group={group}
              label={t(`nav.groups.${group.id}` as any)}
              isExpanded={expandedGroups.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
              onNavigate={onNavigate}
              isAnyChildActive={isAnyChildActive}
            />
          );
        })}
      </nav>
    </aside>
  );
}
