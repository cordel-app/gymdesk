'use client';

import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';

export default function HomePage() {
  const { isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  const locale = useLocale();

  return (
    <main style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Gymdesk</h1>
        <p style={styles.subtitle}>Your gym, in your pocket.</p>

        {!isLoaded ? (
          <p style={styles.hint}>Loading…</p>
        ) : isSignedIn ? (
          <button style={styles.button} onClick={() => router.push(`/${locale}/bookings`)}>
            Go to my bookings
          </button>
        ) : (
          <>
            <button style={styles.button} onClick={() => router.push(`/${locale}/sign-in`)}>
              Sign in
            </button>
            <p style={styles.hint}>Members only. Ask your gym for an invitation.</p>
          </>
        )}
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f5f5',
    padding: 24,
  },
  card: {
    background: '#fff',
    borderRadius: 16,
    padding: '48px 40px',
    maxWidth: 400,
    width: '100%',
    textAlign: 'center',
    boxShadow: '0 2px 16px rgba(0,0,0,0.08)',
  },
  title: {
    margin: '0 0 8px',
    fontSize: 32,
    fontWeight: 700,
    color: '#18181b',
  },
  subtitle: {
    margin: '0 0 32px',
    color: '#71717a',
    fontSize: 16,
  },
  button: {
    display: 'block',
    width: '100%',
    padding: '14px 0',
    background: '#18181b',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    marginBottom: 16,
  },
  hint: {
    color: '#a1a1aa',
    fontSize: 13,
    margin: 0,
  },
};
