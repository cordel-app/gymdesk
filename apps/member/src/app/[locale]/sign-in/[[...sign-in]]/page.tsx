'use client';

import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
      <SignIn />
    </main>
  );
}
