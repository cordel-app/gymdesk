{bucket}/
├── cordel/
│   ├── nutrition
│   │   └── {food_id}-{food_name}.png                                      — 1080 × 1080 px
│   │
│   ├── goals/
│   │   └── {personal_goal_id}-{personnal_goal_name}.png                    — 1080 × 1080 px
│   │
│   ├── muscles/
│   │   └── images/
│   │       ├── {muscle_name}.png                              — 2048 × 2048 px
│   │       └── {muscle_name}-thumbnail.png                    — 512 × 512 px
│   │
│   ├── exercises/
│   │   └── images/
│   │       ├── {exercise_id}-{exercise_name}.png                          — 2048 × 2048 px
│   │       └── {exercise_id}-{exercise_name}-thumbnail.png                — 512 × 512 px
│   │
│   └── themes/
│       └── {theme_id}-{theme_name}/
│           ├── logo/
│           │   └── logo.{extension}                                       — logo del theme
│           │
│           └── members_app/
│               ├── training.png                                           — tamaño definido por el diseño
│               ├── nutrition.png                                          — tamaño definido por el diseño
│               ├── calendar.png                                           — tamaño definido por el diseño
│               ├── bookings.png                                           — tamaño definido por el diseño
│               ├── background.png                                         — tamaño definido por el diseño
│               ├── goals.png                                              — tamaño definido por el diseño
│               ├── bookings.png                                           — tamaño definido por el diseño                                        
│               └── products.png                                           — tamaño definido por el diseño
│
└── gyms/
    └── {gym_id}-{sanitized_gym_name}/
        ├── nutrition
        │   └── {food_id}-{food_name}.png                                      — 1080 × 1080 px
        │        
        ├── goals
        │   └── {personal_goal_id}-{personnal_goal_name}.png                  — 1080 × 1080 px
        │        
        ├── activities
        │   └── {activity_id}-{activity_name}.png                             — 1080 × 1080 px
        │        
        ├── members
        │   └── {member_id}-{member_name}.png                                 — 1080 × 1080 px
        │       
        ├── exercises/
        │   ├── images/
        │   │   ├── {exercise_id}-{exercise_name}.png                         — 2048 × 2048 px
        │   │   └── {exercise_id}-{exercise_name}-thumbnail.png               — 512 × 512 px
        │   │
        │   └── videos/
        │       └── {exercise_id}-{exercise_name}.mp4                       — vídeo
        │
        └── themes/
            └── {theme_id}-{theme_name}/
                ├── logo/
                │   └── logo.{extension}                                   — logo del theme
                │
                └── members_app/
                    ├── training.png                                       — tamaño definido por el diseño
                    ├── nutrition.png                                      — tamaño definido por el diseño
                    ├── calendar.png                                       — tamaño definido por el diseño
                    ├── bookings.png                                       — tamaño definido por el diseño
                    ├── background.png                                     — tamaño definido por el diseño
                    ├── goals.png                                          — tamaño definido por el diseño                    
                    ├── bookings.png                                       — tamaño definido por el diseño                                        
                    └── products.png                                       — tamaño definido por el diseño

---

## What the application creates, and what it does not (#1035)

**Stages 1 and 2 (shipped).** `POST /platform/gyms/:id/storage/initialize`
("Initialize Cloudflare Bucket") writes the **gym** tree only, lowercase, as
zero-byte folder markers: `nutrition/`, `exercises/`, `exercises/images/`,
`exercises/videos/`, `themes/`, since stage 2 `goals/` and since #1374 `members/`.
Every name comes from one constant — `NUTRITION_STORAGE_FOLDER`,
`EXERCISE_STORAGE_FOLDER` and its two leaves, `THEMES_FOLDER`, `GOALS_FOLDER` and
`MEMBERS_FOLDER`, all in `api/src/infra/storage.ts` — which the key builders in
`domain/baseNutritionImages.ts`, `domain/exerciseImages.ts`,
`domain/exerciseVideos.ts`, `domain/themeFolders.ts`, `domain/personalGoalImages.ts`
and `domain/memberImages.ts` re-export, so a marker can never disagree with the keys
written into it. `goals/` is appended last, so a gym's existing markers
keep the order they were written in, and a gym initialized before stage 2 gets the
folder by re-running the action — cosmetic, since R2 has no directories and an
upload stores its object under the prefix either way.

A food's image is `nutrition/<food_id>-<food_name>.<ext>` on both sides:
`POST /nutrition-library/:id/image` for a gym's own food and
`POST /platform/nutrition-library/:id/image` for a base one. The gym route keeps the
four image types the generic upload it replaced accepted (PNG, JPEG, WebP, GIF), so
its extension is the validated MIME type's rather than a fixed `.png`; a PNG upload
produces exactly the name above. The platform route is PNG, 512×512, with an alpha
channel.

**`cordel/` is yours.** Bucket initialization has never created it and must not: the
platform tree above is created by hand in the Cloudflare console. Nothing breaks
before it exists — R2 has no directories, and each platform upload route writes its
own markers on first use.

**`goals/` holds a Personal Goal's image**, the same key one root apart:
`{gym prefix}/goals/{personal_goal_id}-{personal_goal_name}.png` written by
`POST /personal-goals/:id/image`, and `cordel/goals/…` written by
`POST /platform/personal-goals/:id/image` (superadmin) for a System goal
(`personal_goals.gym_id IS NULL`). One column holds both —
`personal_goals.image_url` (migration 225) — and the ownership of the *row* decides
which root its key hangs off; `api/src/domain/personalGoalImages.ts` is the one
place that builds either. The key comes from the row's own id and name and never
from the uploaded file's, so it is deterministic: replacing an image overwrites its
own object, and only a rename moves one (the object left behind is swept then,
best-effort, and only when it belongs to the side doing the replacing — a gym never
deletes a `cordel/` object and the platform never deletes a gym's). The file is a
**PNG of at most 512 × 512 with no transparency requirement**, validated from the
bytes rather than from the `Content-Type` header — deliberately looser than the
exact-square-with-alpha rule a base food's image one folder over is held to. A
Nutrition Goal has no image at all: `IMAGE_GOAL_KINDS` says so, and its
`/:id/image` is a 404 rather than a control that writes nowhere.

`goals/` is the first-level folder that proves #826's rule rather than bending it:
stage 1 deliberately left it out because nothing wrote a Personal Goal image, and it
arrived with its writer.

**`members/` holds a Member's profile image** (#1374):
`{gym prefix}/members/{member_id}-{member_name}.png`, written by
`POST /members/:id/image` (staff, MEMBERS write) and since #1375 by the member's
own `POST /me/profile/image`, cleared by their `DELETE` counterparts — all four
through one module, `api/src/api/member-image-storage.ts`, so the two paths write
the same key and refuse the same bytes. One column holds it — `members.image_url`
(migration 253) — and `api/src/domain/memberImages.ts` is the one place the key is
built and the bytes are judged: a PNG of **exactly** 512 × 512 (the admin crops and
scales whatever staff pick before uploading), no transparency requirement, read from
the bytes rather than the `Content-Type` header. The key is deterministic, so a
replacement overwrites its own object; a **rename** is what moves one, and
`PUT /members/:id` does it in the safe order — copy to the new key, re-point the row,
then delete the old object — leaving the row on the old URL if the copy fails. Gym
root only: a Member belongs to one gym, so there is no `cordel/members/`. A
soft-deleted Member keeps the object (Members have a Recycle Bin restore).
`members/` is appended last to the gym's
first-level markers, with its writer, exactly as `goals/` was — and it is not the
`Members/` #826 removed, which held nothing.

**The `members_app/` slot names above are the target, not the code.** The seven slots
`MEMBER_IMAGE_SLOTS` (`api/src/domain/themeMemberImages.ts`) and the
`chk_theme_member_images_slot` CHECK accept are still `training`, `nutrition`,
`calendar`, `bookings`, `background`, `membership`, `personal_goals` (#1038) and `next_bookings` (#1158, the dashboard's My Next Bookings card, beside and never over `bookings.png`), so
`goals.png` and `products_services.png` are two renames nobody has ticketed yet — a
slot name is a stored object key, so changing one is a migration plus a sweep, not a
line in this file.

**Nothing moved.** Objects stored under the pre-#1035 names — `Nutrition/`,
`Nutrition/Images/<uuid>.<ext>`, `Exercises/Images/`, `Exercises/Videos/`,
`cordel/Nutrition/` — still render, because every URL is derived from the key its row
holds, and in R2 a case difference is a different key rather than a rename. Replacing
that asset is what lands it on the new name; the bulk sweep is a production step, in
`docs/go-to-production.md`.
