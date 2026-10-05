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
│               ├── goals.png                                              — tamaño definido por el diseño
│               └── products_services.png                                  — tamaño definido por el diseño
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
                    ├── goals.png                                          — tamaño definido por el diseño                    
                    └── products_services.png                            — tamaño definido por el diseño

---

## `goals/` — a Personal Goal's image (#1035 stage 2)

Both `goals/` branches above now have a writer, which is the only reason a
first-level folder exists at all (#826):

- **`{gym prefix}/goals/{personal_goal_id}-{personal_goal_name}.png`** — a gym's
  own Personal Goal, written by `POST /personal-goals/:id/image`.
- **`cordel/goals/{personal_goal_id}-{personal_goal_name}.png`** — a System goal
  (`personal_goals.gym_id IS NULL`), written by
  `POST /platform/personal-goals/:id/image` (superadmin).

One column holds both — `personal_goals.image_url` (migration 225) — and the
ownership of the *row* decides which root its key hangs off. The key is built
from the row's own id and name by `api/src/domain/personalGoalImages.ts` and
never from the uploaded file's name, so it is deterministic: replacing an image
overwrites its own object, and a rename is the only thing that moves one (the
object left behind is swept then, best-effort, and only when it belongs to the
side doing the replacing).

The file is a **PNG of at most 512 × 512**, with no transparency requirement —
validated from the bytes rather than from the `Content-Type` header, and
deliberately looser than a Nutrition Library food's exact-square-with-alpha
rule one folder over.

**What the application creates and what it does not.** Gym Bucket Initialization
(`POST /platform/gyms/:id/storage/initialize`) writes the markers for a gym's
own first-level folders, `goals/` among them since this ticket — a gym
initialized earlier gets it by re-running that action, which is cosmetic, since
R2 has no directories and an upload stores its object under the prefix either
way. Nothing under `cordel/` is ever created by initialization; the platform
routes write `cordel/` and `cordel/goals/` on their first upload, so that branch
appears when something is in it. No object is ever moved or renamed by the API:
a key a row still points at is the only way back to its object, so re-spelling
one would strand it (#829).

**Two slot names in the `members_app/` trees above do not match the code**:
`goals.png` and `products_services.png` are drawn here, while the implementation
stores `personal_goals.png` and `membership.png` (#725, #1038). A slot's name
*is* its stored object key, so aligning them is a migration plus a bucket sweep
rather than an edit to this file, and it needs its own ticket.
