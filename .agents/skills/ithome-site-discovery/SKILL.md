---
name: ithome-site-discovery
description: Inspect authenticated and public iT pages without writing site data, discover dynamic series/draft/editor URLs, and calibrate centralized Playwright locators. Use for live selector exploration, series identity checks, or dry-run feasibility validation; do not use it to save a draft or publish.
---

# iT site discovery

Prefer evidence from the visible browser UI and rendered DOM. Do not reverse-engineer or call undocumented publish endpoints.

## Boundary

- Keep URL discovery, selector candidates, parsing, and diagnostic capture in TypeScript under `projects/publisher/src/site/`.
- Keep the interpretation of evidence, safe next-step selection, and stop conditions in this skill.
- Do not create one-off scraping scripts when the knowledge belongs in the maintained adapter and its fixture tests.

## Workflow

1. Run `task draft:preview DAY=N`. This must not alter site data.
2. Validate the authenticated user against `ITHOME_PROFILE_URL` and `ITHOME_USER_IDENTIFIER`.
3. Discover the user article listing and `/YEARironman/create/<id>` editor link through semantic links or href patterns. Cache verified dynamic URLs in ignored runtime state; do not add fake required URLs to `.env`.
4. Compare the live registered series title and category with `IRONMAN_SERIES_TITLE` and `IRONMAN_CATEGORY`. A mismatch is a hard stop before any write.
5. On selector failure, inspect the latest ignored screenshot, HTML, JSON, and trace. Add conservative candidates to `projects/publisher/src/site/locators.ts`, preferring role, accessible name, stable text, and testable attributes.
6. Extend `projects/publisher/test/playwright-e2e.test.ts` for each maintained page-shape assumption, then run `task check` and repeat the dry-run.

Do not treat an untitled or merely same-day draft as Day N. Draft selection requires the exact normalized expected title or a previously verified runtime-state URL.
