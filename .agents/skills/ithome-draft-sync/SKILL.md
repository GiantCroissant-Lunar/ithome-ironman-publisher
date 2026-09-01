---
name: ithome-draft-sync
description: Preview, create, or update one exact iT Ironman draft from a local day-NNN article while preserving image/hash state. Use when the user asks to synchronize local content to a draft; do not use for public publication.
---

# iT draft synchronization

The maintained TypeScript workflow owns all site mutations. Do not reproduce editor filling, image upload, or draft-save behavior in skill prose or shell snippets.

## Preconditions

- The target article passes `task content:check`.
- `task draft:preview DAY=N` succeeds.
- The live registered series title exactly matches `IRONMAN_SERIES_TITLE` and the user's requested destination.
- Authentication is valid. Use `ithome-auth-session` when it is not.
- Creating or updating a draft is within the user's request. A request to inspect or test selectors alone is not authorization to write.

## Workflow

1. Run `task draft:preview DAY=N` and report `would-create` or `would-update` plus the exact title and URL when present.
2. Stop if multiple exact-title drafts exist, the only candidate is untitled, or series identity differs.
3. Run `task draft:sync DAY=N` only after the preconditions hold.
4. Require the adapter to upload only changed images, replace local paths with hosted URLs, save the draft, and read back title and Markdown.
5. Confirm runtime state records `draftUrl`, `sourceHash`, `renderedHash`, asset SHA-256 values, hosted URLs, and `lastSyncedAt`.
6. Report the draft result without clicking publish.

If verification fails after a save attempt, do not blindly retry. Route to `ithome-publish-diagnostics` because the site may already contain a partial change.
