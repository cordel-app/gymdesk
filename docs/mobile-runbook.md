# Mobile shell runbook (manual checks)

**What this is for:** nothing in CI builds the iOS or Android app — CI runs
`npm test` in `api/` only, and the two things that decide whether this shell
works (a signed build on a device, a push arriving on a phone) need a Mac, an
Apple Developer account and a Firebase project. `api/src/test/mobile-shell-profile.unit.test.ts`
and `apps/mobile/src/test/appProfile.test.ts` cover everything that *can* be
asserted offline: that no app identity is hard-coded, that the committed native
projects carry the stage-1 profile, and that the plugin versions match the
Members App's. Everything below is what a person still has to do.

The plan this belongs to is `docs/mobile-app.md` (WP3, [#1074](https://github.com/cordel-app/gymdesk/issues/1074)).
What must be true before publishing is `docs/go-to-production.md` §6.

---

## 0. The workspace

```bash
npm install                       # from the repository root; apps/mobile is a workspace
cd apps/mobile
npm run profile:show              # which app this build is for
```

**Node 22 or newer**, because `@capacitor/cli` declares `engines.node >= 22`.
`npm ci` only warns about it (there is no `engine-strict` in this repository, and
CI's Node 20 never runs `cap`), but every `cap` command below needs it — and
`profile:show` / `profile:apply` run on Node 20 happily, since they are plain
`tsx`.

`profile:show` prints the resolved profile: the app id, the display name, the
URL the shell loads, the navigation allow-list and the URL schemes. It is
`profiles/<MOBILE_APP_PROFILE>.json` (default `cordel-fitness`, the stage-1
generic app) with each field overridden by its own `MOBILE_*` environment
variable — see `apps/mobile/.env.example`.

**There is no web build step.** The app loads the *deployed* Members App from
`server.url`; `www/` holds one local page, shown only by a build with no URL at
all.

## 1. Applying a profile

```bash
npm run profile:apply             # writes the profile into ios/ and android/
npm run sync                      # cap sync: web assets + plugins into both platforms
```

`cap add` seeds the Xcode project, `Info.plist`, Gradle and `strings.xml` from
`capacitor.config.ts` **once**, and `cap sync` then leaves those four alone — so
`profile:apply` is what moves them afterwards. It is idempotent: on an unchanged
profile it reports `already up to date`. Run it after changing a profile, after
switching `MOBILE_APP_PROFILE`, and before any release build.

It also copies the profile's Firebase config, if the profile directory has it:

| From | To |
|---|---|
| `profiles/<id>/google-services.json` | `android/app/google-services.json` |
| `profiles/<id>/GoogleService-Info.plist` | `ios/App/App/GoogleService-Info.plist` |

Both are gitignored on both sides — they belong to a Firebase project, not to
this repository. Without them the app still builds and runs; it just receives no
push (Gradle applies the google-services plugin only when the JSON is there, and
the iOS `AppDelegate` calls `FirebaseApp.configure()` only when the plist is in
the bundle).

**Check after an apply:** `git diff apps/mobile/ios apps/mobile/android` names
the Bundle ID / `applicationId`, the display name and the URL schemes, and
nothing else.

## 2. What is still to be supplied for the stage-1 app

These are configuration, not code, and each one is a `docs/go-to-production.md`
§6 item:

- **Icon and splash.** The committed projects carry Capacitor's placeholder
  artwork. Put `icon.png` (1024×1024) and `splash.png` (2732×2732) in
  `profiles/<id>/` and generate both platforms' assets:
  `npx @capacitor/assets generate --assetPath profiles/cordel-fitness`.
- **Google OAuth clients.** An **iOS** client bound to the Bundle ID and the
  **web** client Clerk holds. Set both as `MOBILE_GOOGLE_IOS_CLIENT_ID` /
  `MOBILE_GOOGLE_WEB_CLIENT_ID` (or in the profile) and run `profile:apply`,
  which registers Google's reversed-client-id URL scheme. The Members App needs
  the same pair as `NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID` /
  `NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID` in **its** build, or it renders no native
  Google button (WP2).
- **An Android OAuth client with the signing SHA-1** (`keytool -list -v -keystore …`),
  for the Google sheet on Android.
- **`FCM_SERVICE_ACCOUNTS`** on the API, keyed by this app's id
  (`com.cordel.fitness`) — #1072.
- **The Firebase iOS SDK**, which is the one step that needs Xcode:
  *File → Add Package Dependencies…* → `https://github.com/firebase/firebase-ios-sdk`,
  product **FirebaseMessaging**, added to the `App` target. The Swift that uses
  it is already in `AppDelegate.swift` behind `#if canImport(FirebaseMessaging)`,
  so the project compiles either way — but **until the package is added, iOS
  registers its APNs token and the API's FCM delivery can never reach it**
  (delivery is FCM HTTP v1, and FCM does not deliver to an APNs token). Android
  needs nothing equivalent: the plugin's token is already an FCM token there.

## 3. iOS — simulator

```bash
cd apps/mobile
npm run sync:ios
npm run open:ios                  # Xcode
```

In Xcode, once per machine: select a team under *Signing & Capabilities* (or use
*Sign to Run Locally* for the simulator), and check that **Push Notifications**
is listed as a capability.

| # | Check | Expected |
|---|---|---|
| 1 | Run on an iPhone simulator | The app launches and loads the Members App. **The first load on a clean install can take close to a minute** (the spike's own finding); the splash and then the Members App's own loading screen cover it |
| 2 | The header | Sits below the status bar — `TopBar` carries `safe-area-inset-top` (WP2) |
| 3 | Sign in with email and password | Session active; the gym's theme is applied after sign-in |
| 4 | Kill and reopen the app | Still signed in |
| 5 | *Continue with Google* (needs §2's clients) | The **native** sheet opens — it must not leave the app for Safari. A `keychain error` here means the `keychain-access-groups` entitlement is not being applied: check `App.entitlements` is still referenced by `CODE_SIGN_ENTITLEMENTS` |
| 6 | Turn off the API, pull to retry | The Members App's error screen with a retry, never "you have no gym" (WP2's `NativeAppState`) |
| 7 | `xcrun simctl openurl booted "com.cordel.fitness://en/link?gym_id=1&__clerk_ticket=x"` | The app comes to the foreground on `/en/link` with the query intact |

A push cannot be tested on the simulator with FCM; §5 is where that happens.

## 4. Android — emulator

```bash
cd apps/mobile
npm run sync:android
npm run open:android              # Android Studio
```

| # | Check | Expected |
|---|---|---|
| 1 | Run on an emulator (API 34+) | Launches and loads the Members App |
| 2 | Sign in, kill, reopen | Still signed in |
| 3 | The back button on a sub-page | Navigates back inside the app rather than closing it |
| 4 | `adb shell am start -a android.intent.action.VIEW -d "com.cordel.fitness://en/link?gym_id=1&__clerk_ticket=x"` | Foregrounds the running app on `/en/link`, not a second instance (`launchMode="singleTask"`) |
| 5 | Notification permission on first sign-in | The system prompt appears (`POST_NOTIFICATIONS` is declared) |

## 5. Physical devices — the checks that decide the acceptance criteria

Needs the Apple Developer account, a real signing identity and the Firebase
project from §2.

| # | Check | Expected |
|---|---|---|
| 1 | Install on a physical iPhone and on a physical Android phone | Both launch and load the Members App |
| 2 | Google sign-in on each | Session active **inside** the app, persisted across a restart |
| 3 | A **first-time** Google sign-in by an invited member, under Clerk's restricted mode | Still open from WP2 — the spike used a user that already existed. If it fails, the fix belongs in `POST /me/link` (match by email + `gym_id`), never in the frontend |
| 4 | `SELECT platform, app_id, LEFT(token, 12) FROM member_device_tokens WHERE member_id = ?` after signing in | One row per device, `app_id` = this app's Bundle ID / package. **On iOS the token must be the FCM token** (~160 characters, mixed case with `:` and `-`), not a 64-character hex APNs token — a hex token means §2's Firebase package step was skipped |
| 5 | Trigger any member notification (a booking confirmation is the cheapest) | The banner arrives on both phones; the API's own log says `push` and not `skipped` |
| 6 | Tap the banner | The app opens `/{locale}/notifications` (WP2: one destination, no per-type route) |
| 7 | Sign out, then trigger another notification | No banner — the token was deleted *before* the session that authenticated the delete ended (WP2's `unregisterPushToken()`) |
| 8 | Sign in as a different member on the **same** handset, then notify the first member | No banner on that handset: `UNIQUE (platform, token)` is global and the `POST` re-points the row to whoever signed in last (#1072) |
| 9 | Release the Members App web build while the app is open and reopen it | The new web release is live with no store review (§2 of the plan) |

## 6. Switching profile (the stage-2 rehearsal)

The acceptance criterion *"changing the app profile needs configuration only, no
code change"* is checked like this — it needs no Mac:

```bash
cd apps/mobile
MOBILE_APP_ID=com.example.gymx MOBILE_APP_NAME="Gym X" \
  MOBILE_SERVER_URL=https://members.example.com npm run profile:apply
git diff --stat apps/mobile                 # four files, no source file
git checkout -- ios android && npm run profile:apply   # back to the stage-1 app
```

A real second app is a second file in `profiles/`, its own Bundle ID / package,
its own Google clients, its own Firebase app, its own signing identity and its
own store listing — and no change to any `.ts`, `.swift` or `.kt` in this
workspace. Read `docs/mobile-app.md` §4's open risks (Apple guideline 4.2.6
above all) before promising a gym its own app.
