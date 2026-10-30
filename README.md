# StudyTime

A mobile-first study timer and class organizer, built to be used on iPhone and iPad.

**Status: per-account local data (M4.1).** There is no backend for study data and no cross-device sync; data is saved in this browser only. Supabase is used for email + password sign-in, and when it is configured each account gets its own local data on the device. Without Supabase variables the app is local-only.

## Run locally

Requires Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

Other scripts:

```bash
npm test                        # vitest (all tests)
npm run lint                    # ESLint
npx tsc --noEmit                # type-check
npm run build && npm start      # production build, served on :3000
node scripts/generate-icons.mjs # regenerate the PNG app icons in public/icons
```

To try it on a phone or iPad on the same network, run `npm run dev -- -H 0.0.0.0` and open `http://<your-computer-ip>:3000`.

## What's in it

| Screen | What works now |
| --- | --- |
| Dashboard | Stopwatch and Countdown timer (default: Stopwatch); Start / Pause / Resume / Stop; class + subgroup picker; today's summary. Paused time is never counted. |
| Classes | Create, rename and delete classes; one level of subgroups per class, with breadcrumb navigation; per-class and per-subgroup time totals. Class names are unique app-wide and subgroup names are unique within a class (case-insensitive). |
| History | Sessions grouped by day, filter by class, empty states. Tap a session to change its class or subgroup. |
| Insights | Daily and weekly charts, class breakdown, current and longest streak. |
| Settings | Light / dark / system theme; Account (sign-in, sign-out, change password); Backup (export study data to JSON, or import one to replace current data); a card for data saved before accounts. The countdown length is set on the Dashboard and remembered. |

See [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) for what has been verified, known issues and the next milestone.

## Mocked or unfinished

- StudyTime starts empty. Classes, subgroups and sessions are saved in `localStorage` on this device, per signed-in account when Supabase is configured (no sync). Insights are computed from your saved sessions.
- `src/lib/legacy-seed.ts` only recognises the old sample records for a one-time cleanup; it is never loaded as data.
- Sign-in needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (see `.env.example`); accounts are created in the Supabase dashboard (no in-app sign-up). Study data does not sync between devices; the database schema in `supabase/` is not used for data yet.
- Next.js dev mode logs an `instant-unrendered-segment` diagnostic on every route; see the status doc.

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
    data/              Classes/sessions store, mirrored to localStorage; account boundary
    auth/              Supabase email + password sign-in
    classes/ history/ insights/ settings/ theme/
  lib/                 Types, helpers, group rules, storage and migrations
```

The UI primitives follow shadcn/ui conventions (Tailwind tokens, `cn()` helper) and use Lucide icons, but were written by hand rather than generated with the shadcn CLI, to keep dependencies to `lucide-react`, `clsx` and `tailwind-merge`.
