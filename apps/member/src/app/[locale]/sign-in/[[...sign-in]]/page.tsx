'use client';

import { SignIn } from '@clerk/nextjs';
import { memberTheme } from '@/lib/memberChrome';

export default function SignInPage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: memberTheme.pageBackground }}>
      <SignIn />
    </main>
  );
}
