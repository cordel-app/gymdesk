# `apps/mobile` — the Capacitor shell

The iOS and Android app (mobile app WP3, [#1074](https://github.com/cordel-app/gymdesk/issues/1074)).
It loads the **deployed** Members App through `server.url`; the UI lives in
`apps/member` and there is no web build step here.

```bash
npm run profile:show     # which app this build is for
npm run profile:apply    # write that profile into ios/ and android/
npm run sync             # cap sync (web assets + plugins)
npm run open:ios         # Xcode   (needs macOS)
npm run open:android     # Android Studio
npm test                 # the profile rules, offline
```

`cap` needs **Node 22+**; the two profile scripts run on Node 20.

- **What a build is for** is `profiles/<id>.json`, overridden per field by the
  `MOBILE_*` variables in `.env.example`. Stage 1 has one profile,
  `cordel-fitness`. It is the only place an app identity may be spelled —
  `api/src/test/mobile-shell-profile.unit.test.ts` fails the build on a literal
  anywhere else.
- **`profile:apply` is the only writer of a native identity**, because `cap add`
  seeds the Xcode project, `Info.plist`, Gradle and `strings.xml` once and
  `cap sync` then leaves them alone.
- **The plan** is `docs/mobile-app.md`; **the manual simulator, device and
  profile-switch checks** are `docs/mobile-runbook.md`; **what is still to be
  supplied** before publishing is `docs/go-to-production.md` §6.
