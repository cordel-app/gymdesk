'use client';

import { useEffect, useState } from 'react';
import { isNative } from './native';

/**
 * #1073 — "is this the native shell?" for a component that **renders**
 * differently because of it.
 *
 * `false` on the first render, always, and the real answer after mount. The
 * bridge is a property of the WebView and does not exist on the server, so asking
 * `isNative()` during render would have the server emit the web markup and the
 * client immediately emit the native markup — a hydration mismatch, and React
 * resolves those by discarding the client tree. One `useEffect` is the whole fix,
 * and it also states the acceptance criterion in code: a web build renders the
 * web UI, since the effect never flips there.
 *
 * A component that only *acts* natively (registering a push token, listening for
 * a link) can call `isNative()` directly inside its own effect — there is no
 * markup to mismatch.
 */
export function useIsNative(): boolean {
  const [native, setNative] = useState(false);
  useEffect(() => {
    setNative(isNative());
  }, []);
  return native;
}
