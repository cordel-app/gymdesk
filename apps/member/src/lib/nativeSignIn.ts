/**
 * #1075 (mobile app WP3b) — how a native Apple identity token becomes a Clerk
 * session. One function, on purpose.
 *
 * **This is unverified.** How Clerk accepts a native Apple token is exactly what
 * #1075's spike has to prove, and it needs an Apple Developer account (the
 * Services ID, Team ID, Key ID and private key of Clerk's Apple connection) and
 * a device. The strategy below is the documented Clerk shape for exchanging a
 * provider token, written down as the hypothesis to test — not as a result.
 * Whatever the spike finds, this is the only place that changes.
 */
export async function signInWithAppleToken(clerk: any, token: string): Promise<void> {
  const signIn = await clerk.client.signIn.create({ strategy: 'oauth_token_apple', token });
  if (signIn.status !== 'complete') throw new Error('apple_sign_in_incomplete');
  await clerk.setActive({ session: signIn.createdSessionId });
}
