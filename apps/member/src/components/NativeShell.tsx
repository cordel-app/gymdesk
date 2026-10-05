'use client';

import { useEffect, useRef } from 'react';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';
import { appUrlOpenPath, isNative, nativePlatform, notificationTapPath } from '@/lib/native';
import { loadAppPlugin, loadPushNotifications } from '@/lib/nativePlugins';
import { registerPushToken } from '@/lib/nativePush';

/**
 * #1073 (mobile app WP2) — the **one** place the Members App wires itself to the
 * native shell. Mounted once by the locale layout, inside `AppProvider`, exactly
 * as `MemberLocalePreference` (#1039) is: it renders nothing, and it is where
 * push registration and link handling live so no page grows a listener of its own.
 *
 * It does three things, and each is gated on `isNative()` inside an effect rather
 * than on a render branch — there is no markup here, so there is nothing to
 * mismatch and the web simply never reaches the plugin loaders.
 *
 * **Registers the push token on sign-in.** The effect runs when a *linked member*
 * is known (`member` + `gymId`), which is this app's definition of signed in: the
 * registration is scoped by gym and resolves the member from the session
 * (#1072), so there is nothing to register before then. Re-registering on every
 * sign-in is deliberate and free — the API's upsert refreshes the row rather than
 * adding one, and it is what takes a shared handset over for whoever signed in
 * last. Permission is requested first and a refusal is final for this run: FCM
 * issues no token without it, so there is nothing to wait for.
 *
 * **Opens the page a tapped notification is about.** `/notifications`, in the
 * app's current locale (`notificationTapPath()`), and never a per-type route — the
 * `data` block carries the type and entity for a later ticket, and the Alerts page
 * is the one screen that answers every type today. A push that arrives while the
 * app is in the foreground refreshes the unread badge instead, because the row it
 * copies is already in the member's list and the badge is what says so.
 *
 * **Routes a link the app was opened with.** `appUrlOpenPath()` decides the path
 * — an invitation link keeps its query, which is what carries `gym_id` and the
 * Clerk ticket, and keeps its own locale. This component only navigates.
 */
export function NativeShell() {
  const locale = useLocale();
  const router = useRouter();
  const { member, gymId, refreshUnreadCount } = useApp();
  const { apiFetch } = useApiClient();

  // `useApiClient()` builds a fresh `apiFetch` on every render, so listing it as
  // a dependency would tear the listeners down and ask for push permission again
  // on every unrelated re-render. The effects below depend only on *who is signed
  // in* and read everything else through this ref — which is also why the link
  // listener is registered once for the life of the app rather than per locale.
  const latest = useRef({ apiFetch, locale, router, refreshUnreadCount });
  latest.current = { apiFetch, locale, router, refreshUnreadCount };

  // ── Push: register this device, and react to its notifications ────────────
  useEffect(() => {
    if (!isNative() || !member || !gymId) return;

    let cancelled = false;
    const handles: { remove: () => Promise<void> | void }[] = [];

    (async () => {
      const platform = nativePlatform();
      const push = await loadPushNotifications();
      if (!platform || !push || cancelled) return;

      try {
        const permission = await push.requestPermissions();
        if (permission.receive !== 'granted' || cancelled) return;

        handles.push(await push.addListener('registration', (token) => {
          if (cancelled) return;
          // Fire-and-forget on purpose: a member whose device cannot be
          // registered still has every alert inside the app (CLAUDE.md — a push
          // is a courtesy copy of a `member_notifications` row).
          void registerPushToken(latest.current.apiFetch, token.value);
        }));

        handles.push(await push.addListener('pushNotificationActionPerformed', () => {
          if (!cancelled) latest.current.router.push(notificationTapPath(latest.current.locale));
        }));

        handles.push(await push.addListener('pushNotificationReceived', () => {
          if (!cancelled) latest.current.refreshUnreadCount();
        }));

        await push.register();
      } catch {
        // A shell without the native half of the plugin, a simulator with no
        // APNs environment, a revoked permission: none of them is a reason to
        // break the page the member is looking at.
      }
    })();

    return () => {
      cancelled = true;
      for (const handle of handles) void handle.remove();
    };
    // `member.id` rather than `member`: the object is replaced on every profile
    // write (#1039's language selector does exactly that), and re-registering on
    // a name change would be noise.
  }, [member?.id, gymId]);

  // ── Links: an invitation or a notification URL the app was opened with ────
  useEffect(() => {
    if (!isNative()) return;

    let cancelled = false;
    let handle: { remove: () => Promise<void> | void } | null = null;

    (async () => {
      const app = await loadAppPlugin();
      if (!app || cancelled) return;
      try {
        handle = await app.addListener('appUrlOpen', ({ url }) => {
          const path = appUrlOpenPath(url, latest.current.locale);
          if (path && !cancelled) latest.current.router.push(path);
        });
      } catch {
        /* as above */
      }
    })();

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, []);

  return null;
}
