# Mobile app (iOS / Android)

**Status: WP1, WP2, WP3 and WP4 done; the shell exists but has not been built on a device or published.** Epic:
[#1078](https://github.com/cordel-app/gymdesk/issues/1078).
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
  because `deploy.yml` writes the API's environment as one `KEY=value` line each into an env
  file (#1192), which takes no multi-line value. A
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

### WP2 — Members App changes (`apps/member`) (#1073) — **done**

Everything in the bullet list landed; what follows is what the implementation decided beyond it,
because WP3 builds the shell against these choices.

- **Two modules, not one.** `lib/native.ts` is the *decision* half — pure, no React, no plugin
  import, no `t()` — and holds `isNative()`, the platform, the registration body, the link rule,
  the Google configuration and the token extraction. `lib/nativePlugins.ts` is the *access* half
  and is the only module in the app that imports a Capacitor package. That split is what makes
  design rule 3 assertable: `native.test.ts` fails the build if any other file under `src`
  mentions `@capacitor/` or `@capgo/`.
- **Every plugin import is dynamic.** The app is server-rendered, so a plugin evaluated at module
  scope would run during SSR and in every browser. `await import()` still ships the package (the
  spike's finding — a remote page gets no `registerPlugin` from the injected bridge, so
  `@capacitor/core` has to be in the web build), and the web never downloads the chunk. A plugin
  the shell does not have loads as `null` rather than throwing: a web release newer than the shell
  on a member's phone must not take the page down.
- **Detection and the registered platform are one answer.** `isNative()` is true for exactly the
  platforms `member_device_tokens.platform` accepts, read from the bridge's own platform string —
  so a future Capacitor target (`electron`) reads as *not* native rather than registering a value
  `chk_mdt_platform` refuses, which is a refusal nobody would ever see (the registration is
  fire-and-forget).
- **A component that renders differently resolves it after mount** (`lib/useIsNative.ts`,
  `false` on the server and on the first client render). Asking during render is a hydration
  mismatch, and React resolves those by discarding the client tree. A component that merely *acts*
  natively calls `isNative()` inside its own effect.
- **Safe areas are not behind `isNative()`.** `env(safe-area-inset-*)` is `0px` wherever there is
  no inset, so `memberChrome.ts`'s `safeArea`/`withSafeArea()` are correct in both builds and no
  new surface has to remember a runtime branch. The top inset is `TopBar`'s **own padding**, so
  the strip under the status bar carries the header's themed background rather than the page
  behind it; the bottom inset is the layout's, once, for every route's last control. The two
  superadmin bars (`AdminBar`, `ImpersonationBanner`) are deliberately untouched — they are
  support chrome, outside the Theme and outside this.
- **The native Google button does not exist unless it can work.** No bridge, or no Google client
  ids in the build, renders nothing at all and leaves the ordinary email-and-password form —
  rather than a control that fails when tapped. The ids are build args
  (`NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID`, wired through
  `apps/member/Dockerfile` and `deploy-member.yml`), per design rule 1. A dismissed sheet returns
  no token and is not an error; only the plugin throwing or Clerk refusing the token says so.
- **Clerk's own Google button is hidden through `appearance`**, both button shapes and the
  divider with them, *only* when native — on the web `appearance` is `undefined` and the sign-in
  screen is unchanged. WP3b adds the Apple button below the card beside the Google one and
  revisits that one set.
- **Push registers on sign-in and unregisters before sign-out.** `NativeShell` (mounted once by
  the locale layout, like `MemberLocalePreference`) registers when a *linked member* is known,
  which is this app's definition of signed in; re-registering is free, since the API's upsert
  refreshes the row and takes a shared handset over. The delete is authenticated as the member
  whose device it is, so it has to run **before** `signOut()` — `lib/nativePush.ts` keeps the
  token in `localStorage` for exactly that, and the one sign-out in the app today (the invitation
  page's, #759) calls it. A tapped notification opens `/notifications` and **no per-type route**:
  the `data` block carries the type and entity for a later ticket, and guessing a destination
  would answer the wrong screen. A push arriving in the foreground refreshes the unread badge.
- **A splash and an error screen with a retry** (`NativeAppState`, native-only so web behaviour is
  unchanged): the first WebView load on a clean install is close to a minute, and an unreachable
  API used to render as "you have no gym". `AppContext` gained `loadError` (a thrown `fetch` or a
  5xx — never a 401/403, which is an answer about who the caller is) and `reload()`, which re-runs
  the load rather than reloading the WebView, so the member keeps their session.
- **`public/`** holds `manifest.json` (standalone, portrait, the `#18181b` of the layout's static
  `theme-color` — both are read before any gym is resolved, so neither can follow a Theme) and
  three PNG icons. `next build` does not fold `public/` into the standalone output, so
  `apps/member/Dockerfile` copies it explicitly: without that line the manifest 404s in production
  exactly as it did before the directory existed.
- Tests: `apps/member/src/test/native.test.ts` (39 — `isNative()` across both bridge shapes and
  both refusals, the registration payload and its four refusals, the link rule for web and
  custom-scheme URLs, the Google configuration per platform, the token extraction, the safe-area
  values and which sign-in button renders) plus `api/src/test/members-app-native.unit.test.ts`
  (6 — the two-module rule itself: one importer, every import dynamic, the decision half pure, the
  platform list equal to the API's `DEVICE_PLATFORMS`, and no render-time `isNative()`). That one
  is in the **API** suite for #1009's reason, the same that put #983's theme gate there: CI runs
  `npm test` in `api/` only, so a scan that has to hold on every push belongs where every push
  runs it. The app's own suite is green at
  18 files / 367 tests and `next build` passes.

**Still not verified, and WP3's to close:** the *first-time* Google sign-in by an invited member
under Clerk's restricted mode. It needs a Clerk instance and an invitation, not a code path, and
the §6 checklist still carries it. If it turns out to need a change, that change belongs in
`POST /me/link` (match by email + `gym_id`), never in the frontend.

### WP3 — Mobile shell (`apps/mobile`, new workspace) (#1074) — **done**

Capacitor 8 with `ios/` and `android/` in the repository, three plugins (`@capacitor/app`,
`@capacitor/push-notifications`, `@capgo/capacitor-social-login`) at the **same versions**
`apps/member` holds, and `www/` holding one local page — the UI is the deployed Members App, so
there is no web build step here. What follows is what the implementation decided beyond the
bullet list, because WP3b, WP4 and WP5 all build on it.

- **The app profile is the whole of design rule 1.** `profiles/<id>.json` is the one place an app
  identity may be spelled (app id, display name, `server.url`, `allowNavigation`, the two Google
  client ids); `MOBILE_*` variables override it **per field**, so a CI build points the generic
  app at a staging URL without editing a profile and a per-gym profile needs no environment at
  all. `appId`, `appName` and `serverUrl` have **no fallback in code** — a shell with no Bundle ID
  would install over another app's identity and one with no URL would open a blank WebView — and
  the custom URL scheme defaults to the app id rather than to a literal. The resolution is pure
  (`src/appProfile.ts`), the file and the environment are the I/O half
  (`src/loadAppProfile.ts`), and both `capacitor.config.ts` and the apply script come through the
  second, so a `cap sync` and an apply can never disagree about what is being built.
- **`npm run profile:apply` exists because `cap sync` does not write identity.** `cap add` seeds
  the Xcode project, `Info.plist`, Gradle and `strings.xml` from `capacitor.config.ts` once and
  `cap sync` then copies only web assets and plugins — so those four need a writer, and
  `src/nativeProjectFiles.ts` is it: pure text transforms (assertable with no macOS machine), each
  of which **throws rather than reporting success** when its anchor is gone, because the failure
  that matters is an apply that leaves the previous gym's Bundle ID in place. It is idempotent,
  and it also copies the profile's `google-services.json` / `GoogleService-Info.plist` when the
  profile directory has them (both gitignored on both sides — they belong to a Firebase project,
  not to this repository).
- **Google's URL scheme is derived, not configured.** It is the reversed client id, a mechanical
  transform of the id itself, so asking a profile for it as a second field is how the two come to
  disagree. A build with **no** client id registers no Google scheme at all, which matches WP2's
  rule that the native button is absent rather than broken in such a build.
- **Android's `namespace` is read, not written.** It is the package the checked-in `MainActivity`
  and the generated `R`/`BuildConfig` live under; `applicationId` is what the Play Store and FCM
  identify the app by, and the two have been allowed to differ since AGP 7. Moving the namespace
  would mean moving source files rather than editing a value — and reading it is also what keeps
  the template's package out of the apply script as a literal.
- **A URL opened on a running app reaches the *scene* delegate.** `Info.plist` declares
  `UIApplicationSceneManifest`, so iOS delivers `scene(_:openURLContexts:)` and **not**
  `application(_:open:options:)` — which is what the plugin's own README (written for the
  pre-scene template) documents. `NativeSignInUrl.handle` is therefore one rule asked from both,
  rather than a handler in the delegate that never runs. Anything a sign-in SDK does not consume
  goes to Capacitor, which is how a custom-scheme link becomes `appUrlOpen` and WP2's
  `appUrlOpenPath()` turns it into an in-app path.
- **The iOS token has to be the FCM token, and that needs one Xcode step.** Delivery is FCM
  HTTP v1 (WP1), and FCM does not deliver to an APNs token, so `AppDelegate` hands the APNs token
  to `Messaging` and posts Firebase's token as Capacitor's `registration` value. Both that and
  `GIDSignIn.handle` sit behind **`#if canImport`**: `GoogleSignIn` is a transitive dependency of
  the social-login plugin rather than a product this target declares, and `FirebaseMessaging` is
  added in Xcode by whoever has the `GoogleService-Info.plist` — so the project compiles with
  neither, and **until the Firebase package is added iOS push cannot be delivered**
  (`docs/mobile-runbook.md` §2 and `docs/go-to-production.md` §6 both carry it). Android needs no
  counterpart: the plugin's token is already an FCM token there.
- **Two entitlements, written from build settings.** `keychain-access-groups` is the spike's own
  finding (§3 — without it a simulator build fails Google Sign-In with `keychain error`) and is
  `$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)` so a second profile needs no edit;
  `aps-environment` is `development`, and a store build needs `production`.
- **Android's manifest gains two things**: an intent filter on `@string/custom_url_scheme`, which
  is how a link reaches the app until WP4's App Links exist (`launchMode="singleTask"` is already
  in the template, which is what makes it arrive on the running app), and `POST_NOTIFICATIONS`,
  without which WP2's permission request on sign-in could only ever be denied.
- Tests: `apps/mobile/src/test/appProfile.test.ts` (21 — the resolution and its refusals, the
  per-field override, the scheme derivation, every transform including its escaping and its
  throw, and that applying the stage-1 profile to the committed projects changes nothing) plus
  `api/src/test/mobile-shell-profile.unit.test.ts` (15 — no identity literal outside `profiles/`,
  the committed projects matching the profile, the synced `capacitor.config.json` agreeing, the
  shell's app id equal to the API's `DEFAULT_APP_ID`, the plugin versions equal to the Members
  App's, and the native wiring above). That second one is in the **API** suite for #1009's
  reason: CI runs `npm test` in `api/` only.

**Not verified here, and WP5's to close:** every acceptance criterion that needs a build. This
container has no macOS, no Xcode and no Android SDK, so neither platform has been compiled, no
simulator or device has run the app, and no push has been delivered. `docs/mobile-runbook.md` is
the list of those checks; §2 of it is the configuration still to be supplied (icon and splash
artwork, the Google clients, the Android SHA-1, `FCM_SERVICE_ACCOUNTS`, the Firebase iOS
package).

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
- **Decided (Q1 ticket), stage 1 built — the API half.** The invitation, not the address, names the
  member: `POST /members/:id/invite` and `/reinvite` stamp the Clerk invitation with
  `publicMetadata.member_invite = { gym_id, member_id }` (server-set, copied by Clerk onto the user
  who signs up through the ticket, like #599's `gym_signup`), and `POST /me/link` matches that
  member first (`api/src/domain/memberInviteTarget.ts`), cleared afterwards. The email match stays
  the fallback, so invitations issued before this carry no metadata and behave as before; the
  staff-collision guard applies to the ticket path too. A relay-address sign-in now links.
- **Stage 2 — still to do, and only the owner can close it:** the Apple spike (Services ID, Team ID,
  Key ID, private key, the capability, a physical iPhone), the Clerk Apple connection and the
  `apple` provider in `nativePlugins.ts` behind WP2's "absent when it cannot work" rule.

### WP4 — Universal links / app links (#1076) — **done (code), unverified on a device**

An invitation link tapped in Mail or Notes opens the app rather than the browser. Both platforms
grant that only when **two halves** line up: the domain publishes a file naming the app, and the
app declares the domain. Each half is one place.

- **The web half is two routes in `apps/member`**, over two modules: `lib/appAssociations.ts`
  decides what the files *say* (pure — no `fs`, no `next/*`, so the documents are assertable with
  no server, no device and no store account) and `lib/wellKnownResponse.ts` decides how they are
  *served*. `app/api/well-known/apple-app-site-association/route.ts` and
  `…/well-known/assetlinks/route.ts` hold the route and nothing else, and both are
  `force-dynamic`: the documents are built from the environment per request, so a statically
  prerendered route would bake the build container's empty configuration into the deployment.
- **The canonical paths are reached by a rewrite, never a redirect.** `next.config.js` maps
  `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` onto those routes.
  Apple refuses an association file reached through a redirect, and a rewrite is internal, so the
  `200` stays on the URL iOS asked for. The handlers live under `app/api/` because a directory
  beginning with a dot is not a path the app router is guaranteed to publish, and
  `assetlinks.json`'s extension belongs to the URL rather than to a folder name. The middleware
  never runs on either canonical path — its matcher excludes anything containing a dot, which both
  of them do, and the gate asserts that *regex* rather than the comment claiming it, because Apple
  and Google fetch these with no session and no `Accept-Language` and must not meet Clerk or the
  locale redirect.
- **What a build is for is configuration, in one variable keyed by app id.**
  `MOBILE_APP_ASSOCIATIONS` is a JSON object (or that JSON base64-encoded, for the quadlet
  environment) naming each app's Apple Team ID and Android SHA-256 signing fingerprints — the
  shape `FCM_SERVICE_ACCOUNTS` already uses (#1072) and for its reason: a stage-2 per-gym app is a
  new key, never a code change and never a new variable name to invent. It is env rather than a
  profile field because `apps/member`'s Docker build copies `apps/member` and `shared` only and
  cannot see `apps/mobile/profiles/`, and because a Team ID and a release certificate belong to
  the store account rather than to the shell's source. Either half may be omitted — an iOS-only
  release is a real state.
- **A malformed entry is dropped, reported and never published; a file with nothing to say is a
  404.** These files are fetched by Apple's and Google's CDNs and cached for up to a day, so
  publishing a wrong `appID` or a SHA-1 where a SHA-256 belongs claims an association that
  silently cannot work — worse than claiming none. One app's typo therefore costs that app its
  links and not another app's, the error is logged by the route (the parser is pure and logs
  nothing), and a `200` carrying an empty `details` array is not an option: it reads as
  "configured, associates nothing", which is indistinguishable from a working file in a log.
  That is WP2's "a native control that cannot work is absent, never broken", one layer down.
- **The native half is written from the app profile by `npm run profile:apply`**, which stays the
  only writer of a native identity (WP3): the `associated-domains` entitlement
  (`applinks:<host>`) in `ios/App/App/App.entitlements`, and `@string/app_link_host` for the
  Android `intent-filter`. The host is **derived**, not configured — it is the host of the
  profile's own `serverUrl`, because that deployment is what serves the association files, so a
  field beside it could only ever disagree with the domain Apple and Google verify. Ticking
  *Associated Domains* in Xcode instead would carry one gym's host into every other profile's
  build.
- **Which paths open the app is one declaration, spelled in two syntaxes.** An invitation is
  `/{locale}/link?gym_id=…&__clerk_ticket=…`, so `APP_LINK_PATH_SEGMENT` is the whole rule and the
  Apple component (`/*/link`) and the Android `pathPattern` (`/.*/link`) are derived from it. The
  app claims that path and **not** the whole domain: a filter over `/*` would swallow the OAuth
  and Clerk redirects a sign-in bounces through, and a link the app takes at the wrong moment has
  no way back to the browser. `apps/mobile` cannot import that module (another workspace, and the
  manifest is XML), so `api/src/test/mobile-app-links.unit.test.ts` fails the build when the
  committed manifest or entitlement stops matching it — a drift is otherwise invisible until the
  same link opens the app on iOS and the browser on Android.
- **No new link rule.** WP2's `appUrlOpenPath()` already reads an `https` URL, which is what a
  universal link arrives as, and already preserves the query (the query *is* the invitation) and
  the link's own locale. The custom URL scheme stays registered beside the new filter, because it
  is what still reaches the app from an in-app browser that does not trigger a universal link and
  from a build whose domain is not verified yet.
- **Degrading is the point.** With `MOBILE_APP_ASSOCIATIONS` unset both files are a 404,
  verification fails, and a tapped invitation opens in the browser and completes there — which is
  exactly today's behaviour. Nothing about the invitation, `POST /me/link` or the member's session
  changes.
- Tests: `apps/member/src/test/app-associations.test.ts` (23 — the parse and each of its
  refusals, both encodings, the per-app isolation of a typo, fingerprint normalization including
  the SHA-1 mistake, and both documents including their two `null` cases) and the WP3 suite
  extended for the derived host and the two new transforms, plus
  `api/src/test/mobile-app-links.unit.test.ts` (11 — the drift gate above: the routes, the
  rewrite, the middleware regex, the entitlement, the `autoVerify` filter and the one path
  declaration). Both files were also fetched over a real `next start`: `200` +
  `application/json` on both canonical paths with the variable set, `404` on both without it, and
  no redirect either way.

**Not verified here, and WP5's to close:** every acceptance criterion that needs a device. No
build has been made, so no install has verified an `assetlinks.json` and no link has been tapped
in Mail or Notes. Two things have to be supplied before either can be: the **Apple Team ID** and
the **Android signing fingerprints** (upload *and* Play App Signing, which re-signs the app — the
Play Console's own fingerprint is the one an installed release verifies against), both in
`MOBILE_APP_ASSOCIATIONS`, and the *Associated Domains* capability on the App ID in the Apple
Developer portal, which the entitlement alone does not grant. `docs/mobile-runbook.md` §2 and
`docs/go-to-production.md` §6 carry both.

**Known caveat, by design:** some in-app browsers do not trigger a universal link at all — a mail
client that opens links in its own WebView, and Gmail on Android for a link in its own viewer.
The link then opens in that browser and the invitation completes there, which is why the flow must
never depend on the app receiving it.

**Found by testing (dev, 2026-10-08): the invitation email never contains a link on our domain.**
Clerk sends the invitation, and its button is
`https://<clerk frontend api>/v1/tickets/accept?ticket=…`, which redirects to `/{locale}/link`
afterwards. A universal link / App Link only fires for a URL *tapped* on the app's domain, and a
server redirect does not count, so for a Clerk invitation the association files cannot open the app.
They still serve any link we write ourselves. The answer built for it: `/link` (`lib/openInApp.ts`)
shows **Open in the app** / **Continue in the browser** to a phone's browser holding a ticket,
*before* redeeming it (a ticket is single-use), and the first opens the app's custom scheme
(`NEXT_PUBLIC_MOBILE_APP_SCHEME`, no offer when unset). Own-domain email links (sending the
invitation ourselves with `notify: false`) are the alternative if one tap fewer is wanted.

### WP5 — Production and publication (#1077)
See `docs/go-to-production.md` §6.

## 6. Out of scope

Per-gym apps (stage 2), offline mode, widgets, and any change to payments or billing.
