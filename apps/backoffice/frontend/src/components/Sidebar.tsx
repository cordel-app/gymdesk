'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/', label: 'Dashboard' },
  {
    href: '/members',
    label: 'Members',
    children: [
      { href: '/members/deleted', label: 'Deleted Members' },
    ],
  },
  { href: '/classes', label: 'Classes' },
  { href: '/bookings', label: 'Bookings' },
  { href: '/subscriptions', label: 'Subscriptions' },
];

export function Sidebar() {
  const pathname = usePathname();

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
      <div style={{ padding: '24px 20px 20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <strong style={{ fontSize: 18 }}>Gymdesk</strong>
      </div>
      <nav style={{ padding: '12px 0' }}>
        {links.map(({ href, label, children }) => {
          const active = href === '/' ? pathname === href : pathname === href || (!!children && pathname.startsWith(href));
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
                  fontSize: 14,
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
                          fontSize: 13,
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
