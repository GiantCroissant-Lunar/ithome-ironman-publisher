---
name: ithome-publish
description: Publish the due iT Ironman article through the verified Playwright workflow and confirm it on the public page. Use only when the user explicitly asks for real publication or scheduler execution; do not use for previews, selector tests, or draft-only synchronization.
---

# iT publication and verification

Public posting is an external communication. Do not infer permission from requests to test, inspect, prepare, or create a draft.

## Preconditions

- The user explicitly requested public publication.
- Authentication, exact series identity, Day N, timestamp, local content, and exact draft selection are verified.
- `task publish:dry` succeeds and reports the expected action.
- No unresolved exit-code 8 or partial-site-state incident exists.
- The repository process lock is available.

## Workflow

1. Run `task publish:dry` with `PUBLISH_DRY_RUN=true` and review the exact title, Day N, and destination evidence.
2. Keep the registered-series mismatch check as a hard stop. Never publish an ADE article into a differently named series merely because its editor URL is the only available link.
3. For the authorized live run, set the ignored local safety lock `PUBLISH_DRY_RUN=false` and run `task publish`. Both the environment lock and `--publish` entrypoint must be present.
4. Let the TypeScript workflow recheck the public listing before mutation, synchronize and verify the draft, publish once, and poll the public listing for the exact title and today's Taipei date.
5. Restore `PUBLISH_DRY_RUN=true` after an attended validation run unless the user is deliberately enabling the scheduler.
6. Report the verified public article URL and persisted runtime state.

If the publish click may have succeeded but public verification fails, do not retry. Route to `ithome-publish-diagnostics`; the next safe action starts with a public idempotency check.
