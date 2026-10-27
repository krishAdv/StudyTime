# StudyTime

A mobile-first study timer and class organizer, built to be used on iPhone and iPad.

**Status: UI-only milestone.** There is no backend, no sign-in, and no cross-device sync. Data is saved in this browser only.

## Run locally

Requires Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

Other scripts:

```bash
npm run lint                    # ESLint
npx tsc --noEmit                # type-check
npm run build && npm start      # production build, served on :3000
node scripts/generate-icons.mjs # regenerate the PNG app icons in public/icons
```

To try it on a phone or iPad on the same network, run `npm run dev -- -H 0.0.0.0` and open `http://<your-computer-ip>:3000`.

## What's in it

| Screen | What works now |
| --- | --- |
| Dashboard | Stopwatch, Custom countdown and Pomodoro timer; Start / Pause / Resume / Stop; class + nested-group picker; today's summary and recent sessions. Pomodoro break time is shown separately and never counted as study time. |
| Classes | Create, rename and delete classes; unlimited nested groups with breadcrumb navigation; per-class and per-group time totals. |
| History | Sessions grouped by day, filter by class, empty states. |
| Insights | Daily and weekly charts, class breakdown, current and longest streak. |
| Settings | Light / dark / system theme; custom timer and Pomodoro durations. |

## Mocked or unfinished

- StudyTime starts empty. Classes, subgroups and sessions are saved in `localStorage` on this device (no sync). Insights are computed from your saved sessions.
- `src/lib/legacy-seed.ts` only recognises the old sample records for a one-time cleanup; it is never loaded as data.
- No Supabase, auth, or API keys.

## PWA status

A web manifest (`src/app/manifest.ts`), app icons (`public/icons`), and Apple web-app metadata are in place, so "Add to Home Screen" on iOS should give a standalone app with an icon. This has **not** been verified on a physical device, and there is **no service worker**, so the app does not work offline and should not yet be considered a fully installable PWA.

## Project layout

```
src/
  app/                 Routes (thin pages), layout, manifest
  components/
    layout/            App shell: sidebar, mobile tab bar, theme toggle
    ui/                Reusable primitives (button, card, dialogs, select, ...)
  features/
    timer/             Timer state machine (provider), timer card, today summary
    data/              In-memory classes/sessions store (future data-layer seam)
    classes/ history/ insights/ settings/ theme/
  lib/                 Types, helpers, group rules, storage and migrations
```

The UI primitives follow shadcn/ui conventions (Tailwind tokens, `cn()` helper) and use Lucide icons, but were written by hand rather than generated with the shadcn CLI, to keep dependencies to `lucide-react`, `clsx` and `tailwind-merge`.
