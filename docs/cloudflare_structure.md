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
│   │       ├── {muscle_name}-male.webp                              — 1080 × 1080 px
│   │       ├── {muscle_name}-male-thumbnail.webp                  — 256 × 256 px
│   │       ├── {muscle_name}-female.webp                            — 1080 × 1080 px
│   │       └── {muscle_name}-female-thumbnail.webp                  — 256 × 256 px
│   │
│   ├── exercises/
│   │   ├── images/
│   │   │   ├── {exercise_id}-{exercise_name}-male.webp                          — 1080 × 1080 px
│   │   │   ├── {exercise_id}-{exercise_name}-male-thumbnail.webp                — 256 × 256 px
│   │   │   ├── {exercise_id}-{exercise_name}-female.webp                        — 1080 × 1080 px
│   │   │   └── {exercise_id}-{exercise_name}-female-thumbnail.webp              — 256 × 256 px
│   │   │
│   │   └── videos/
│   │       ├── {exercise_id}-{exercise_name}-male.mp4                    — video
│   │       ├── {exercise_id}-{exercise_name}-male.webp                   — 1080 x 1080        
│   │       ├── {exercise_id}-{exercise_name}-male-thumbnail.webp         — 256 x 256        
│   │       ├── {exercise_id}-{exercise_name}-female.webp                 — 1080 x 1080        
│   │       ├── {exercise_id}-{exercise_name}-female-thumbnail.webp       — 256 x 256        
│   │       └── {exercise_id}-{exercise_name}-female.mp4                  — vídeo
│   │
│   └── themes/
│       └── {theme_id}-{theme_name}/
│           ├── logo/
│           │   └── logo.{extension}                                       — logo del theme
│           │
│           └── members_app/
│               ├── training.png                                           — 1080 × 1080 px
│               ├── nutrition.png                                          — 1080 × 1080 px
│               ├── calendar.png                                           — 1080 × 1080 px
│               ├── bookings.png                                           — 1080 × 1080 px
│               ├── background.png                                         — 1080 × 1080 px
│               ├── goals.png                                              — 1080 × 1080 px
│               ├── bookings.png                                           — 1080 × 1080 px                                        
│               └── products.png                                           — 1080 × 1080 px
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
        │   ├── {activity_id}-{activity_name}.png                             — 1080 × 1080 px
        │   └── event-{event_id}-{activity_name}.png                          — 1080 × 1080 px (a single Calendar Event's own image, #1382)
        │        
        ├── members
        │   ├── {member_id}-{member_name}.webp                                — 1080 × 1080 px
        │   └── {member_id}-{member_name}-thumbnail.webp                      — 256 × 256 px
        │       
        ├── exercises/
        │   ├── images/
        │   │   ├── {exercise_id}-{exercise_name}-male.webp                    — 1080 × 1080 px        
        │   │   ├── {exercise_id}-{exercise_name}-male-thumbnail.webp          — 256 × 256 px        
        │   │   ├── {exercise_id}-{exercise_name}-female.webp                  — 1080 × 1080 px
        │   │   └── {exercise_id}-{exercise_name}-female-thumbnail.webp        — 256 × 256 px
        │   │
        │   └── videos/
        │       ├── {exercise_id}-{exercise_name}-male.mp4                    — video
        │       ├── {exercise_id}-{exercise_name}-male.webp                   — 1080 x 1080        
        │       ├── {exercise_id}-{exercise_name}-male-thumbnail.webp         — 256 x 256        
        │       ├── {exercise_id}-{exercise_name}-female.webp                 — 1080 x 1080        
        │       ├── {exercise_id}-{exercise_name}-female-thumbnail.webp       — 256 x 256        
        │       └── {exercise_id}-{exercise_name}-female.mp4                  — vídeo
        │
        └── themes/
            └── {theme_id}-{theme_name}/
                ├── logo/
                │   └── logo.{extension}                                   — logo del theme
                │
                └── members_app/
                    ├── training.png                                       — 1080 × 1080 px
                    ├── nutrition.png                                      — 1080 × 1080 px
                    ├── calendar.png                                       — 1080 × 1080 px
                    ├── bookings.png                                       — 1080 × 1080 px
                    ├── background.png                                     — 1080 × 1080 px
                    ├── goals.png                                          — 1080 × 1080 px                    
                    ├── bookings.png                                       — 1080 × 1080 px                                        
                    └── products.png                                       — 1080 × 1080 px

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

**`members/` holds a Member's profile image** (#1374, reshaped by #1449):
`{gym prefix}/members/{member_id}-{member_name}.webp` (1080 × 1080) and
`…-thumbnail.webp` (256 × 256), written by `POST /members/:id/image` (staff,
MEMBERS write) and by the member's own `POST /me/profile/image`, cleared by their
`DELETE` counterparts — all four through one module,
`api/src/api/member-image-storage.ts`. The client sends **one** picture as it is
(JPEG, PNG, WebP or GIF, up to `MEMBER_IMAGE_MAX_MB`); the **server** applies its
orientation, centre-crops to a square and encodes both WebP files in memory
(`api/src/domain/memberImageProcessing.ts`), so nothing is written to disk and no
browser-side processing exists. Both objects are uploaded before the row moves and
two columns hold them — `members.image_url` and `members.image_thumbnail_url` — set
in one `UPDATE`. `api/src/domain/memberImages.ts` is the one place the keys are
built. The keys are deterministic, so a replacement overwrites its own objects; a
**rename** is what moves them, and `PUT /members/:id` does it in the safe order —
copy both to the new keys, re-point the row, then delete the old objects — leaving
the row on the old pair if a copy fails. Gym root only: there is no
`cordel/members/`. A soft-deleted Member keeps the objects (Members have a Recycle
Bin restore).
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

## Exercise gender media (#1420)

Stage 1 stores only the master reference per file in `exercises.image_male_url`, `image_female_url`, `video_male_url` and `video_female_url` (migration 276). The thumbnail of an image (`-thumbnail.webp` beside the master) and a video's preview and preview thumbnail (`.webp` and `-thumbnail.webp` beside the `.mp4`, always under `videos/`) are derived from the stored URL; no thumbnail column exists. The legacy `image_url`, `image_thumbnail_url`, `video_url` and `video_thumbnail_url` stay until the last stage moves every consumer and drops them.

Since stage 2 the **server** makes the WebP files, through `POST`/`DELETE /exercises/:id/(image|video)/:gender` and the `/platform/exercises` mirror (one factory, `api/src/api/exercise-gender-media.ts`):

- **An image upload** sends one picture as it is (JPEG, PNG, WebP or GIF, up to `EXERCISE_IMAGE_MAX_MB`, default 10, clamped at 25) as `{ image }`, base64 in a JSON body. `api/src/domain/exerciseImageProcessing.ts` (`sharp`, in memory) orients it, **contains** it whole in a 1080 × 1080 canvas with transparent padding — never stretched, never cropped; this is deliberately not the Member photo's centre-crop — encodes the master and makes the 256 × 256 thumbnail **from that master**, and verifies both are WebP of exactly that size before anything is uploaded. The input is judged from its decoded bytes, never from `Content-Type` or a file name.
- **A video upload** sends `{ video, frame }`: the MP4 (validated from its bytes, `EXERCISE_VIDEO_MAX_MB`) and one frame the browser captured from it, because `sharp` cannot decode MP4 and no `ffmpeg` is installed. The frame is processed exactly like an image upload and stored as the video's preview and preview thumbnail under `videos/`; it never touches an image column. A request with no frame is a 400.
- **Nothing is uploaded or written until every file is valid**; a failed upload removes only the objects it created, and the row takes its column in one `UPDATE`.
- **Uploads are rate limited per signed-in person** (`EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_MAX`, default 30 per 15 minutes, on top of the global budget) and decoding is bounded process-wide (`api/src/domain/imageProcessingSlot.ts`, shared with the Member photo).
