# Mobile app (iOS / Android)

**Status: planned, nothing is built.** Epic: [#1078](https://github.com/cordel-app/gymdesk/issues/1078).
This file is the plan and the record of what a feasibility spike (2026-10-04) proved. Decisions that are settled live in
`docs/decisions.md` (#18); what must be true before launch lives in
`docs/go-to-production.md` §6. Update this file as each work package lands.

## 1. Goal and staging

The Members App (`apps/member`, today a Next.js PWA at `members.vdicube.com`) must run as a
store app on iOS and Android.

- **Stage 1 (now): one generic app**, "Cordel Fitness", published by us. A member signs in and
  the gym's theme is applied after login, exactly as on the web today.
- **Stage 2 (later, on request): one app per gym** that asks for its own — the gym's name and
  icon in the store, the same Members App inside.

**Stage 1 is the only scope being built, but it is designed for stage 2.** Every choice below
is made so that a gym app is a second *profile* of the same shell, never a fork. Where a choice
costs nothing now and would cost a migration later, it is made now (see §4).

## 2. Approach

A **Capacitor 8** shell loads the deployed Members App through `server.url`. The UI stays in
`apps/member`; there is no second front end. The shell adds only what a web page cannot do:
native Google/Apple sign-in, push notifications and links that open the app.

Why not a rewrite (Expo/React Native): it would duplicate the whole member UI and double the
maintenance, for no gain the product needs yet. Why not a plain PWA: no store presence, and iOS
web push only works for an installed PWA.

Consequences of loading a remote URL: web releases reach the app **without a store review**; a
change to native code, plugins or permissions still needs one. If the web is down, so is the app,
so the shell needs an error screen with a retry.

## 3. What the spike proved (iOS 27 simulator, Clerk Development instance)

| Check | Result |
|---|---|
| Members App inside the WebView, with the gym theme | Works |
| Email + password sign-in | Works |
| Session after killing and reopening the app | Persists |
| Clerk's default "Continue with Google" | **Leaves the app** (opens the system browser); the session lands in Safari, not in the WebView. Not usable as is |
| Native Google sign-in → `Clerk.authenticateWithGoogleOneTap({ token })` | **Works.** Session `ACTIVE` inside the WebView, persisted across restarts |

Facts learned that the code must respect:

- The ID token's `aud` must be the **web** OAuth client (the one Clerk holds), so the plugin is
  initialised with `iOSClientId` (the iOS client) **and** `iOSServerClientId` (the web client).
- A remote page does not get `window.Capacitor.registerPlugin` from the native bridge: the web
  bundle must include `@capacitor/core`, active only when running natively.
- The Bundle ID lives in the Xcode project (`PRODUCT_BUNDLE_IDENTIFIER`), not in
  `capacitor.config`. A Google iOS client is bound to it.
- Simulator builds need an ad-hoc signature plus a `keychain-access-groups` entitlement, or Google
  Sign-In fails with `keychain error`.
- The first WebView load on a clean install is very slow (close to a minute in the simulator):
  show a splash/loading screen.
- The header currently renders under the status bar: `TopBar` needs `safe-area-inset-top`.

**Not proven yet:** a *first-time* sign-in with Google by an invited member under Clerk's
restricted mode (the spike used a user that already existed); Android; a physical device; Sign in
with Apple; universal links; push.

## 4. Design rules for stage 2 (apply them in stage 1)

1. **No app identity is hard-coded.** Bundle ID / package name, display name, `server.url`,
   Google client IDs and Firebase config come from build-time configuration. `apps/mobile` is
   parameterised by an *app profile*; stage 1 has exactly one profile.
2. **Push tokens record the app.** `member_device_tokens.app_id` (the Bundle ID / package of the
   app that registered the token, default = the generic app) exists from the first migration, and
   the sender resolves FCM credentials per `app_id`. Adding it later is a data migration.
3. **Everything native sits behind one module** (`apps/member/src/lib/native.ts`, `isNative()`).
   A plain browser never executes native code.
4. **Association files list apps, not an app.** `apple-app-site-association` and `assetlinks.json`
   are generated from the list of app profiles.
5. **The web may need to know which app it runs in** (to brand the login screen before anyone has
   signed in). One way is for the shell to append an identifier to the user agent. This is a design
   to validate, not something tried. After sign-in nothing changes: the member's gym already
   decides what they see (`GymSwitcher` is hidden when the actor has a single gym), so locking the
   app to one gym is a small, optional hardening, not a requirement.
6. **Per-gym apps multiply the store plumbing, not the code:** one Bundle ID, Google iOS/Android
   client, Firebase app, signing identity, store listing and review per gym.

### Open risks that decide whether stage 2 is viable (verify before promising it to a gym)

- **Apple guideline 4.2.6** (apps generated from a template): Apple may require each gym's app to
  be submitted from the **gym's own Apple Developer account**, not from ours. That would mean one
  account and one D-U-N-S per gym. Read the current text of the guideline before offering this.
- **Sign in with Apple across Bundle IDs:** check whether Clerk accepts a native Apple token whose
  audience is a different Bundle ID per gym app.
- **Pre-login branding** (rule 5) is only a sketch.

## 5. Work packages (one PR each, in this order)

### WP1 — Device tokens (API contract first) (#1072) — **done**

Migration 221 and the routes landed as specified; what follows is what the implementation decided
beyond the bullet list, because WP2 and WP5 both depend on it.

- **`member_device_tokens`** (migration 221): `gym_id` NOT NULL, `member_id`, `platform`
  (`chk_mdt_platform` = `ios`|`android`), `app_id` (VARCHAR(191), default `com.cordel.fitness`),
  `token` (VARCHAR(512)), `last_seen_at`, `created_at`; `UNIQUE (platform, token)`;
  `KEY (gym_id, member_id)` for the delivery read; both FKs `ON DELETE CASCADE`.
- **`POST /me/devices`** and **`DELETE /me/devices/:token`** on the `me` router
  (`requireRole('member')`, the member resolved from the session, every query filtered by
  `gym_id`). The `POST` is an upsert on the unique key that re-points `gym_id`/`member_id` and
  refreshes `last_seen_at`, so re-registering on every sign-in (WP2) adds no rows and a **shared
  handset** is taken over by whoever signed in last — the token identifies an app installation,
  not a person. It answers 201 with the row minus the token (the caller already has it). The
  `DELETE` is scoped by gym *and* member, so another member's token is a 404.
  `parseDeviceRegistration()` (`api/src/domain/deviceTokens.ts`) is the only place a body is
  judged: an unknown platform, a blank token or an over-wide value is a 400, never a coercion.
- **Delivery** is `api/src/infra/push.ts` over the pure `api/src/domain/pushDelivery.ts`, called by
  all three `member_notifications` writers (`sendNotification`, `sendBulkNotification`,
  `recordNotifications`) after the insert and never awaited. No notification type was added.
- **FCM HTTP v1, no SDK**: a service-account JWT signed with `node:crypto` is exchanged for an
  access token (cached per project) and one POST goes out per token. `firebase-admin` would be a
  large dependency for one signed HTTP call, and the legacy server-key API is decommissioned.
- **Credentials are one variable**, `FCM_SERVICE_ACCOUNTS`: a JSON object keyed by **app id**
  (design rule 2), each value a Google service-account JSON, accepted raw or **base64-encoded**
  because `deploy.yml` writes the API's environment as inline quadlet `Environment=` lines. A
  stage-2 per-gym app is therefore a new key, not a code change; a token whose `app_id` has no
  entry is skipped rather than failed, which is what that app's unconfigured Firebase project
  looks like. `MOBILE_DEFAULT_APP_ID` overrides the app id a registration defaults to.
- **A dead token is deleted only when FCM says it is dead** — `UNREGISTERED` or
  `SENDER_ID_MISMATCH`. `INVALID_ARGUMENT` is kept deliberately: FCM answers it for a malformed
  *message* as well, so deleting on it would empty the table on the first bug in the message
  builder. A 429 or a 5xx is an unknown outcome, not evidence against the token.
- **The push carries no sentence.** It sends the payload's own `title` and a `data` block (type,
  entity, payload) for routing; the per-type copy a member reads lives in the Members App's locale
  files, and composing it here would be a second copy of it in a module that would have to pick a
  language. A member's stored `preferred_locale` (#1039) makes that answerable — answering it is
  the ticket that decides where push copy lives.
- Tests: `me-devices.test.ts` (integration — 401/403, register, idempotent upsert, shared-device
  takeover, platform separation, validation, delete, cross-member and cross-gym isolation, and
  that a failing send leaves both the notification row and the token alone), plus
  `device-tokens.unit.test.ts`, `push-delivery.unit.test.ts` and `push.unit.test.ts` (the delivery
  loop with the database mocked and `fetch` stubbed, so FCM's whole protocol is covered offline).
  `cleanupTestGyms` extended.

**Not verified here**, and WP5's to close: a real delivery. Nothing in this repository has FCM
credentials, so no notification has reached a physical device yet.

### WP2 — Members App changes (`apps/member`) (#1073)
- Create `public/` with `manifest.json` and icons (the layout already links `/manifest.json`, which
  404s today).
- `lib/native.ts` (`isNative()`, `@capacitor/core` in the bundle); `safe-area-inset` on `TopBar`
  and the navigation; a splash/loading state and an error screen with retry.
- `NativeGoogleButton`, visible only when native: calls the plugin
  (`@capgo/capacitor-social-login`) and hands the token to Clerk. The default Google button of
  `<SignIn />` is hidden in the app through `appearance`.
- Register/unregister the push token; `appUrlOpen` routes invitation links to `/link` and a tapped
  notification to `/notifications`.
- First sign-in with Google by an invited member under restricted mode: verify, and if it needs a
  change, make it in `POST /me/link` (match by email + `gym_id`), never in the frontend.
- Tests (vitest): `isNative()`, which button renders, the token-registration payload.

### WP3 — Mobile shell (`apps/mobile`, new workspace) (#1074)
- Capacitor 8, `ios/` and `android/` in the repo. `capacitor.config.ts` reads `server.url` and
  `allowNavigation` from environment variables.
- iOS: URL scheme for Google in `Info.plist`, `GIDSignIn.handle` in `AppDelegate`, keychain
  entitlement, icon, splash. Android: OAuth client with SHA-1, `google-services.json`.
- A manual runbook for simulator and physical-device checks (no automated suite covers native
  behaviour; CI runs `npm test` in `api/` only).

### WP3b — Sign in with Apple (iOS) (#1075)
- **Why:** App Store guideline 4.8 asks for an equivalent privacy-preserving login option when the
  app offers a third-party login (Google). Sign in with Apple is the standard way to satisfy it.
  Check the current text at review time. It is **not** required for push (push is not an Apple
  requirement; it is the strongest answer to guideline 4.2, "minimum functionality").
- Clerk: Apple connection with our own credentials (Services ID, Team ID, Key ID, private key).
  App: the plugin's `apple` provider and the *Sign in with Apple* capability.
- **Run a spike first**, as for Google: how Clerk accepts a native Apple token is not known.
- **Risk — the relay email.** Apple lets the user hide their email and returns
  `…@privaterelay.appleid.com`, which does not match the address the gym invited, while
  `POST /me/link` matches by **email + `gym_id`**. Options to decide after the spike: (1) link by
  the invitation ticket instead of the email; (2) let a signed-in member attach Apple/Google to an
  existing account; (3) let the gym link manually.

### WP4 — Universal links / app links (#1076)
- Serve `/.well-known/apple-app-site-association` (`Content-Type: application/json`, no redirect)
  and `/.well-known/assetlinks.json` from `apps/member`; the middleware matcher already skips paths
  containing a dot, which must be checked. Add *Associated Domains* to the app.
- Done when an invitation link (`/link?gym_id=…&__clerk_ticket=…`) opened from Notes or Mail opens
  the app. Needs the Apple Developer account.

### WP5 — Production and publication (#1077)
See `docs/go-to-production.md` §6.

## 6. Out of scope

Per-gym apps (stage 2), offline mode, widgets, and any change to payments or billing.
