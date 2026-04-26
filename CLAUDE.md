# CLAUDE.md — `yl-hb-am` (AllMusic news scraper)

Conventions shared across the `yl-hb-*` fleet live in
[`SCRAPER-CLAUDE-TEMPLATE.md`](../SCRAPER-CLAUDE-TEMPLATE.md) — read both.

## What this repo does

Two TypeScript scrapers that pull music journalism from **AllMusic**:
the standard News feed and the Blog feed. Articles are upserted into
`public.news`. Author bylines and source-domain links get reflected
into `public.hb_socials` where appropriate.

## Stack

**Standard enrichment** variant: TypeScript via `ts-node`,
`@supabase/supabase-js`, `cheerio` (HTML parsing — no browser needed),
`dotenv`. Service-role Supabase access.

## Repo layout

```
src/
  allmusic-news-scraper.ts          # main news feed
  allmusic-blog-news-scraper.ts     # blog feed
  supabase.ts                       # service-role client
import-hb-socials.js                # one-off helper, not on cron
.github/workflows/
  allmusic-news-scraper.yml
  allmusic-blog-news-scraper.yml
package.json
tsconfig.json
```

## Supabase auth

Standard fleet convention — `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`,
client in `src/supabase.ts`.

## Workflow lifecycle convention

Standard: both workflows call `log_workflow_run` start + result. Workflow
ids are hardcoded numerics matching `public.workflows.github_workflow_id`
(this repo's local convention — same pattern as `yl-hb-imdbp`, not the
`vars.WORKFLOW_ID_*` form in the parent template).

## Tables this repo touches

| Table | Operation | Notes |
|---|---|---|
| `public.news` | UPSERT | Primary write target; one row per article. |
| `public.hb_socials` | UPSERT | Reflected source-domain links / author bylines. |

## Running locally

```bash
npm install
cp .env.example .env.local            # if present; otherwise create
# Set: SUPABASE_URL, SUPABASE_SERVICE_KEY
# Optional: PROFILE_LIMIT, MAX_PAGES, CONCURRENCY, WORKFLOW_ID
npx ts-node --transpile-only src/allmusic-news-scraper.ts
```

## Per-repo gotchas

- **Cheerio-only, no browser.** AllMusic doesn't require JS execution
  for the news feeds. If you hit anti-bot blocks, the right move is to
  add user-agent rotation, not switch to Puppeteer.
- **Two separate workflows for News vs Blog.** They don't share state
  beyond the database. Don't merge them — the cadences and the parsing
  are different.
- **`import-hb-socials.js` is a one-off helper**, not scheduled. Don't
  delete it without checking it isn't referenced from a runbook.
- **The `public.news` table is also written by `yl-hb-imdb`,
  `yl-hb-rgm`, `yl-hb-tmdb`, `yl-hb-imdbp`** — coordinate slug or
  `(source_domain, source_url)` uniqueness if changing the schema.

## Conventions Claude should follow when editing this repo

All the fleet-wide rules from [`SCRAPER-CLAUDE-TEMPLATE.md`](../SCRAPER-CLAUDE-TEMPLATE.md)
apply. Specifically here:

- **Don't introduce Puppeteer** unless AllMusic adds JS-gated content.
  Cheerio is faster and CI-friendlier.
- **Hardcode the GitHub workflow id in the YAML** matching this repo's
  local convention (look at the existing two workflows for examples).

## Related repos

- `yl-hb-imdb`, `yl-hb-rgm`, `yl-hb-imdbp`, `yl-hb-tmdb` — sibling
  enrichers that also write to `public.news`.
- `hb_app_build` — Next.js app reading the data.
