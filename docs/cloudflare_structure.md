{bucket}/
├── cordel/
│   ├── nutrition
│   │   └── {food_id}-{food_name}.png                                      — 512 × 512 px
│   │
│   ├── goals/
│   │   └── {personal_goal_id}-{personnal_goal_name}.png                    — 512 × 512 px
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
│               ├── personal_goals.png                                      — tamaño definido por el diseño
│               └── membership.png                                         — tamaño definido por el diseño
│
└── gyms/
    └── {gym_id}-{sanitized_gym_name}/
        ├── nutrition
        │   └── {food_id}-{food_name}.png                                      — 512 × 512 px
        │        
        ├── goals
        │   └── {personal_goal_id}-{personnal_goal_name}.png                    — 512 × 512 px
        │       
        ├── exercises/
        │   ├── images/
        │   │   ├── {exercise_id}-{exercise_name}.png                       — 2048 × 2048 px
        │   │   └── {exercise_id}-{exercise_name}-thumbnail.png             — 512 × 512 px
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
                    ├── personal_goals.png                                 — tamaño definido por el diseño                    
                    └── membership.png                                     — tamaño definido por el diseño

---

## What the application creates, and what it does not (#1035)

**Stage 1 (shipped).** `POST /platform/gyms/:id/storage/initialize` ("Initialize
Cloudflare Bucket") writes the **gym** tree only, lowercase, as zero-byte folder
markers: `nutrition/`, `exercises/`, `exercises/images/`, `exercises/videos/` and
`themes/`. Every name comes from one constant — `NUTRITION_STORAGE_FOLDER`,
`EXERCISE_STORAGE_FOLDER` and its two leaves, and `THEMES_FOLDER`, all in
`api/src/infra/storage.ts` — which the key builders in `domain/baseNutritionImages.ts`,
`domain/exerciseImages.ts`, `domain/exerciseVideos.ts` and `domain/themeFolders.ts`
re-export, so a marker can never disagree with the keys written into it.

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

**`goals/` is stage 2.** Nothing writes a Personal Goal image yet, so initialization
does not create that folder: a first-level folder no writer populates is what #826
removed from this tree. It arrives with the column, the routes and the editor control.

**Nothing moved.** Objects stored under the pre-#1035 names — `Nutrition/`,
`Nutrition/Images/<uuid>.<ext>`, `Exercises/Images/`, `Exercises/Videos/`,
`cordel/Nutrition/` — still render, because every URL is derived from the key its row
holds, and in R2 a case difference is a different key rather than a rename. Replacing
that asset is what lands it on the new name; the bulk sweep is a production step, in
`docs/go-to-production.md`.
