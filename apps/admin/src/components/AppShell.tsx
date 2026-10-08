'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Sidebar } from './Sidebar';
import { TopHeader } from './TopHeader';
import { ImpersonationBanner } from './ImpersonationBanner';
import { ListResponsiveStyles } from './ListResponsiveStyles';
import { SIDEBAR_EXPANDED_WIDTH } from '@/lib/sidebarCollapse';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isSignedIn, isLoaded } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Height of the fixed top bar (impersonation banner + header). The banner can
  // appear, disappear, or wrap onto several lines, so measure instead of assuming 52px.
  const topBarRef = useRef<HTMLDivElement>(null);
  const [topBarHeight, setTopBarHeight] = useState(52);
  const isAuthPage = /\/(sign-in|sign-up)/.test(pathname);
  // The public privacy policy renders bare, like sign-in: visitors are usually signed out.
  const isPublicPage = /^\/[a-z]{2}\/privacy$/.test(pathname);
  const isHomePage = /^\/[a-z]{2}$/.test(pathname);

  useEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTopBarHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  });

  // #883: the mobile drawer scrolls on its own, so the document behind it is
  // frozen while it is open. The class is only honoured under the mobile media
  // query, so the desktop sidebar is unaffected.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('sidebar-drawer-open', sidebarOpen);
    return () => document.body.classList.remove('sidebar-drawer-open');
  }, [sidebarOpen]);

  if (isAuthPage || isPublicPage || (isHomePage && (!isLoaded || !isSignedIn))) {
    return <>{children}</>;
  }

  return (
    <>
      {/* #1011: the list chrome's mobile rules, mounted once for every screen. */}
      <ListResponsiveStyles />

      <div ref={topBarRef} style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50 }}>
        <ImpersonationBanner />
        <TopHeader onMenuToggle={() => setSidebarOpen((v) => !v)} />
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            zIndex: 40, display: 'none',
          }}
          className="mobile-overlay"
        />
      )}

      <div style={{
        display: 'flex', minHeight: '100vh', paddingTop: topBarHeight,
        ['--gd-top-bar-h' as string]: `${topBarHeight}px`,
      }}>
        <div className={`sidebar-wrapper${sidebarOpen ? ' sidebar-open' : ''}`}>
          <Sidebar onNavigate={() => setSidebarOpen(false)} />
        </div>
        <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', minWidth: 0 }} className="main-content">
          {children}
        </main>
      </div>

      <style>{`
        /* #883: the wrapper is what bounds the navigation. It lays its panel out
           in a column so the panel is exactly the wrapper's height on both
           breakpoints, which is what gives the nav inside it something finite to
           scroll within. */
        .sidebar-wrapper {
          display: flex;
          flex-direction: column;
          /* The panel's own flex-shrink: 0 moved here with it: the wrapper is
             what the shell lays out in a row, so it is what must not be
             squeezed by a wide page. */
          flex-shrink: 0;
        }
        @media (max-width: 768px) {
          .sidebar-wrapper {
            position: fixed;
            top: var(--gd-top-bar-h, 52px);
            left: -${SIDEBAR_EXPANDED_WIDTH}px;
            /* The drawer never exceeds the viewport below the top bar. 100dvh
               follows the mobile browser's collapsing address bar; 100vh is the
               fallback where it is unsupported. */
            height: calc(100vh - var(--gd-top-bar-h, 52px));
            height: calc(100dvh - var(--gd-top-bar-h, 52px));
            overflow: hidden;
            z-index: 45;
            transition: left 0.25s ease;
          }
          .sidebar-wrapper.sidebar-open {
            left: 0;
          }
          .mobile-overlay {
            display: block !important;
          }
          .main-content {
            padding: 20px 16px !important;
          }
          /* While the drawer is open the page behind it does not scroll, so a
             swipe that starts on the navigation stays in the navigation. */
          body.sidebar-drawer-open {
            overflow: hidden;
          }
        }
        @media (min-width: 769px) {
          .sidebar-wrapper {
            position: relative;
            left: 0 !important;
          }
          /* #1242: on desktop the page scrolls, so the sidebar is pinned under
             the top bar and bounded to the viewport; the nav inside it is then
             the scroll container the mouse wheel acts on. The bound is on the
             panel, never the wrapper, which stays a plain relative column. */
          .sidebar-panel {
            position: sticky;
            top: var(--gd-top-bar-h, 52px);
            flex: none !important;
            height: calc(100vh - var(--gd-top-bar-h, 52px));
            height: calc(100dvh - var(--gd-top-bar-h, 52px));
          }
        }
      `}</style>
    </>
  );
}
