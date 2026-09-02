---
name: ithome-publish
description: Publish the due iT Ironman article through the verified Playwright workflow and confirm it on the public page. Use only when the user explicitly asks for real publication or scheduler execution; do not use for previews, selector tests, or draft-only synchronization.
---

# iT publication and verification

Public posting is an external communication. Do not infer permission from requests to test, inspect, prepare, or create a draft.

## Preconditions

- The user explicitly requested public publication.
- Authentication, exact series identity, Day N, timestamp, final text, final images, and exact draft selection are verified. Do not publish with an intention to add required media afterward.
- When the Day has an image plan, selected generated assets, or local image references, `task images:check DAY=N` and `task content:check` succeed, and the latest verified draft readback contains every expected hosted image URL.
- `task publish:dry` succeeds and reports the expected action.
- No unresolved exit-code 8 or partial-site-state incident exists.
- The repository process lock is available.
- The current Git branch has an upstream, is fully synchronized with it, and the working tree is clean. The preflight fetch and push dry-run must succeed so the publication receipt can be pushed without mixing unrelated changes.

## Workflow

1. Run `task publish:dry` with `PUBLISH_DRY_RUN=true` and review the exact title, Day N, and destination evidence.
2. Keep the registered-series title and category mismatch checks as hard stops. Never publish an article into a differently named series merely because its editor URL is the only available link.
3. For the authorized live run, set the ignored local safety lock `PUBLISH_DRY_RUN=false` and run `task publish`. Both the environment lock and `--publish` entrypoint must be present.
4. Let the TypeScript workflow recheck the public listing before mutation, synchronize and verify the full draft including expected image URLs, publish once, and poll the public listing for the exact title and today's Taipei date.
5. Require the workflow to parse the article ID from the verified public URL, write the immutable `articles/day-NNN/publication.json`, commit only that receipt, and push it to the configured upstream.
6. Restore `PUBLISH_DRY_RUN=true` after an attended validation run unless the user is deliberately enabling the scheduler.
7. Independently verify the public article body contains the expected number of images and exact hosted image URLs; a matching title and date alone are insufficient when the source contains images.
8. Report the verified public article URL, article ID, image verification result, receipt path, commit/push result, and persisted runtime state.

If the publish click may have succeeded but public verification fails, do not retry. Route to `ithome-publish-diagnostics`; the next safe action starts with a public idempotency check.

If exit code 10 occurs, treat the article as already public. Do not run the live publish path again merely to repair Git. After verifying the public Day/title/URL and removing unrelated repository changes, run `task publication:sync DAY=N`; provide `ARTICLE_URL=https://ithelp.ithome.com.tw/articles/ID` only when ignored runtime state no longer contains it.
