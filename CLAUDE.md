# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**ghostty.style** is a community gallery for [Ghostty](https://ghostty.org) terminal themes. Users browse/search themes, preview them in a simulated terminal, vote, install via a one-line `curl`, and upload their own configs (validated against the Ghostty config reference). It's a Next.js 16 (App Router, React 19) app backed by Supabase (Postgres + RLS), deployed on Vercel.

## Commands

This repo uses **pnpm** (`packageManager` is pinned in `package.json`; a `pnpm-lock.yaml` is committed alongside an unused `package-lock.json`).

```bash
pnpm install            # install deps
pnpm dev                # run dev server (next dev) at http://localhost:3000
pnpm build              # production build
pnpm start              # serve production build
pnpm lint               # eslint (flat config, eslint-config-next + typescript rules)
npx tsx scripts/seed-themes.ts   # seed DB from the iTerm2-Color-Schemes repo (idempotent)
```

There is **no test suite** and no separate typecheck script — type errors surface via `pnpm build`. There is no single-test runner because there are no tests.

### Environment

Copy `.env.example` to `.env.local` and fill in real values. `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are required for the app; the seed script additionally needs `SUPABASE_SERVICE_ROLE_KEY`. `.env*` is gitignored (except `.env.example`) — never commit real credentials.

## Architecture

### Data flow: raw config → parsed columns → rendered preview

The core domain object is a Ghostty config. The pipeline:

1. **`src/lib/config-parser.ts`** is the heart of the app. It parses raw Ghostty config text into a `ParsedConfig` (background, foreground, cursor, 16-color `palette`, font, opacity, `isDark`, etc.), producing structured `errors`/`warnings`. It holds `KNOWN_GHOSTTY_KEYS` (the full key set from the Ghostty config reference) used to warn about unrecognized keys. Three exported functions matter:
   - `parseGhosttyConfig(raw)` — extract visual properties + validation diagnostics.
   - `cleanRawConfig(raw)` — strip inline and whole-line comments. Ghostty only supports whole-line comments, so inline comments (`background = #000 # dark`) would break `curl`-installed configs. **Always run before storing or serving raw config.** It is idempotent.
   - `serializeGhosttyConfig(config)` — render a `ParsedConfig` back to text.
2. On **upload** (`POST /api/configs`), the parsed visual fields are **denormalized into dedicated DB columns** so the gallery and previews never re-parse at read time. The cleaned raw text is also stored.
3. On **render**, `src/lib/db.ts::mapRowToConfig` maps a snake_case DB row to the camelCase `GhosttyConfig` type (`src/types/config.ts`). The terminal preview (`src/components/terminal-preview.tsx`) reuses these columns plus sample content from `src/lib/terminal-content.ts` (ANSI palette indices 0–15).

When you change the set of parsed/stored fields, you typically touch four places in lockstep: the parser, the DB migration/columns, `mapRowToConfig`, and the `GhosttyConfig`/`ParsedConfig` types.

### Routes (App Router, `src/app`)

- Pages: `/` (home), `/browse` (search/filter/sort grid), `/upload` (submit form), `/config/[slug]` (detail with live preview + install command).
- Detail pages dedupe their Supabase query with React `cache()` so `generateMetadata` and the page body share one roundtrip; slugs are validated against `/^[a-z0-9-]+$/` before querying.
- SEO/social: `sitemap.ts`, `robots.ts`, and `config/[slug]/opengraph-image.tsx` (dynamic OG images).
- API (`src/app/api/configs`):
  - `GET /` — list with `q`, `tag`, `dark`, `sort` (`popular`|`newest`|`trending`|`iterm2`), `page`. Cached via `s-maxage`.
  - `POST /` — upload (parse + clean + slug generation + tag validation).
  - `[id]/vote` `POST`/`DELETE` — voting.
  - `[id]/download` `GET` — returns cleaned config as a `.conf` attachment, fires an atomic download-count increment.

### Supabase / database

Two thin client factories in `src/lib/supabase/`: `server.ts` (`createServerClient`, used in API routes / RSC) and `client.ts` (`createClient`, memoized singleton for browser). Both use the **anon key only** — there is no service-role usage in the app; only the seed script uses the service role.

Schema lives in `supabase/migrations/` (apply in numeric order via the Supabase SQL editor or CLI):
- `001` — `configs`, `votes`, `analytics_events` tables; GIN indexes for tags + full-text search; triggers (`vote_count` auto-maintained from `votes` rows, `updated_at`); RLS enabled.
- `002` — **security hardening**: removed the open UPDATE/DELETE policies and routed counter writes through `SECURITY DEFINER` RPCs (`increment_view_count`, `increment_download_count`) so anon clients can't directly mutate counters.
- `003` / `004` — `upstream_added_at` (original iTerm2 upload time) and a generated `sort_date = COALESCE(upstream_added_at, created_at)` column powering the sort modes.

**Key invariant:** anon clients cannot UPDATE configs directly. Counter increments must go through the RPC functions (e.g. `supabase.rpc("increment_download_count", ...)`), not `.update()`. Votes are deduped by `voter_hash` (sha256 of IP+user-agent) and a unique constraint; the trigger keeps `vote_count` in sync.

### Security model

Because anyone can submit without auth, defenses live in the API layer:
- **Rate limiting** (`src/lib/rate-limit.ts`): in-memory, per-serverless-instance (soft protection — noted as "good enough for launch", swap for KV/Redis for hard guarantees). Upload = 5/hr/IP, vote = 60/min/IP. IP via `getClientIp` (`x-forwarded-for`).
- **Input validation** on upload: size caps (config ≤50KB, title ≤100, description ≤280, author ≤50), tags filtered against `AVAILABLE_TAGS` and capped at 5, dark/light tag auto-added from parse result.
- **Injection guards**: search `q` is stripped to `[a-zA-Z0-9 -]` before being interpolated into a PostgREST `.or()` string; all `[id]` params validated against a UUID regex; slugs validated against `/^[a-z0-9-]+$/`.
- **Security headers** set globally in `next.config.ts` (HSTS, X-Frame-Options DENY, nosniff, etc.).

## Conventions

- **Imports** use the `@/*` alias → `src/*` (configured in `tsconfig.json`).
- **UI**: Tailwind CSS v4 (config-less; global styles + theme tokens in `src/app/globals.css`) with **shadcn/ui** (new-york style, components in `src/components/ui/`, configured in `components.json`). Add components with the `shadcn` CLI. Icons from `lucide-react`. Use `cn()` from `src/lib/utils.ts` for class merging.
- **Constants** (page size, the canonical `AVAILABLE_TAGS` list, default palette/colors) live in `src/lib/constants.ts` — reuse these rather than hardcoding.
- **DB naming**: Postgres is snake_case, app types are camelCase; cross the boundary only through `mapRowToConfig`.
- **Analytics**: Plausible via `next-plausible` (proxied through `next.config.ts`) plus `@vercel/analytics`.

## Git workflow

Active development branch for this work: `claude/claude-md-docs-jUl5u`. Develop, commit, and push there; do not push to `main` or open a PR unless explicitly asked.
