'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

export function Sidebar() {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();

  const links = [
    { href: `/${locale}`, label: t('nav.dashboard') },
    {
      href: `/${locale}/members`,
      label: t('nav.members'),
      children: [
        { href: `/${locale}/members/deleted`, label: t('nav.members_deleted') },
      ],
    },
    { href: `/${locale}/classes`, label: t('nav.classes') },
    { href: `/${locale}/bookings`, label: t('nav.bookings') },
    { href: `/${locale}/subscriptions`, label: t('nav.subscriptions') },
  ];

  return (
    <aside style={{
      width: 220,
      background: '#1a1a2e',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      minHeight: '100vh',
    }}>
      <nav style={{ padding: '12px 0', flex: 1 }}>
        {links.map(({ href, label, children }) => {
          const active = pathname === href;
          const isParentOfActive = !!children && pathname.startsWith(href);

          return (
            <div key={href}>
              <Link
                href={href}
                style={{
                  display: 'block',
                  padding: '10px 20px',
                  color: active ? '#fff' : 'rgba(255,255,255,0.6)',
                  textDecoration: 'none',
                  background: active && !isParentOfActive ? 'rgba(255,255,255,0.1)' : 'transparent',
                  borderLeft: active && !isParentOfActive ? '3px solid #6c63ff' : '3px solid transparent',
                  fontWeight: active ? 600 : 400,
                  fontSize: 15,
                }}
              >
                {label}
              </Link>

              {children && isParentOfActive && (
                <div>
                  {children.map((child) => {
                    const childActive = pathname === child.href;
                    return (
                      <Link
                        key={child.href}
                        href={child.href}
                        style={{
                          display: 'block',
                          padding: '8px 20px 8px 36px',
                          color: childActive ? '#fff' : 'rgba(255,255,255,0.5)',
                          textDecoration: 'none',
                          background: childActive ? 'rgba(255,255,255,0.1)' : 'transparent',
                          borderLeft: childActive ? '3px solid #6c63ff' : '3px solid transparent',
                          fontWeight: childActive ? 600 : 400,
                          fontSize: 14,
                        }}
                      >
                        {child.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

    </aside>
  );
}
