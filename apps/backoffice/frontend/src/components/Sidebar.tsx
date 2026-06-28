'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';

export function Sidebar() {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const { isSuperadmin } = useGym();

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

  const systemLinks = [
    { href: `/${locale}/system/gyms`, label: t('nav.gyms') },
  ];

  function NavLink({ href, label, indent = false }: { href: string; label: string; indent?: boolean }) {
    const active = pathname === href;
    return (
      <Link
        href={href}
        style={{
          display: 'block',
          padding: indent ? '8px 20px 8px 36px' : '10px 20px',
          color: active ? '#fff' : 'rgba(255,255,255,0.6)',
          textDecoration: 'none',
          background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
          borderLeft: active ? '3px solid #6c63ff' : '3px solid transparent',
          fontWeight: active ? 600 : 400,
          fontSize: indent ? 14 : 15,
        }}
      >
        {label}
      </Link>
    );
  }

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
      <nav style={{ padding: '12px 0', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1 }}>
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
                    {children.map((child) => (
                      <NavLink key={child.href} href={child.href} label={child.label} indent />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {isSuperadmin && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 8, marginTop: 8 }}>
            <p style={{
              padding: '6px 20px',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              color: 'rgba(255,255,255,0.35)',
              margin: 0,
              textTransform: 'uppercase',
            }}>
              {t('nav.system')}
            </p>
            {systemLinks.map(({ href, label }) => (
              <NavLink key={href} href={href} label={label} />
            ))}
          </div>
        )}
      </nav>
    </aside>
  );
}
