import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Gymdesk',
  description: 'Gym Management Backoffice',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f5f5f5' }}>
        <nav style={{ background: '#1a1a2e', color: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center', height: 56 }}>
          <strong style={{ fontSize: 18 }}>Gymdesk</strong>
        </nav>
        <main style={{ maxWidth: 960, margin: '32px auto', padding: '0 24px' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
