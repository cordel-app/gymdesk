'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { TopHeader } from './TopHeader';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = /\/(sign-in|sign-up)/.test(pathname);

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <>
      <TopHeader />
      <div style={{ display: 'flex', minHeight: '100vh', paddingTop: 52 }}>
        <Sidebar />
        <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
          {children}
        </main>
      </div>
    </>
  );
}
