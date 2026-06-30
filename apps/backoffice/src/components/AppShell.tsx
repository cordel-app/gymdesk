'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { TopHeader } from './TopHeader';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isAuthPage = /\/(sign-in|sign-up)/.test(pathname);

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <>
      <TopHeader onMenuToggle={() => setSidebarOpen((v) => !v)} />

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

      <div style={{ display: 'flex', minHeight: '100vh', paddingTop: 52 }}>
        <div className={`sidebar-wrapper${sidebarOpen ? ' sidebar-open' : ''}`}>
          <Sidebar onNavigate={() => setSidebarOpen(false)} />
        </div>
        <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', minWidth: 0 }} className="main-content">
          {children}
        </main>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .sidebar-wrapper {
            position: fixed;
            top: 52px;
            left: -220px;
            height: calc(100vh - 52px);
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
        }
        @media (min-width: 769px) {
          .sidebar-wrapper {
            position: relative;
            left: 0 !important;
          }
        }
      `}</style>
    </>
  );
}
