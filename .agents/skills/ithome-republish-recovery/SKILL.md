---
name: ithome-republish-recovery
description: Replace one already-published same-day iT Ironman article when the published editor irreversibly strips required media. Use only after explicit authorization to delete and republish; do not use for normal edits, drafts, or ordinary publication.
---

# iT same-day republish recovery

This is a destructive recovery workflow. Deleting an Ironman article can affect the series' daily continuity, and a new article normally receives a different ID. Explain that risk and require explicit authorization for the exact Day, title, and public URL before any deletion.

## Preconditions

- Use this only after `ithome-publish-diagnostics` proves that ordinary published-article updates cannot preserve the required content.
- The replacement must happen on the original publication date in `Asia/Taipei`, before the site's daily deadline.
- Confirm the exact account, registered series, category, Day number, title, article ID, and public URL from both local state and the live page.
- Require a clean, upstream-synchronized Git branch, successful `task content:check`, and reachable hosted image URLs.
- Preserve `articles/day-NNN/publication.json` as immutable history. A replacement must get a separate lineage record; never overwrite the original receipt.
- For the exact Day 002 precedent, consult `docs/incidents/2026-09-02-day-002-image-republication.md`; use its evidence as a precedent, not as authorization to delete a different article.

## Workflow

1. Save the original article ID, URL, title, publication time, local source hash, rendered hash, and current public status in ignored diagnostics before deletion.
2. Use the repository's saved headed Playwright Edge session. Never use or copy cookies from the user's everyday Edge profile.
3. Locate the delete control from the authenticated page, verify its form or endpoint targets the exact article ID, invoke it once, and handle any site confirmation. Do not use a guessed DELETE endpoint.
4. Verify both that the old URL is no longer public and that the exact title is absent from today's registered-series listing. If deletion is ambiguous, stop without retrying.
   The user's article listing can retain a card marked `title-badge--delete`; treat it as a tombstone, not as a public article or draft.
5. Clear only the ignored Day runtime pointers that refer to the deleted article or draft. Retain verified hosted asset URL/SHA pairs so the new draft can reuse them.
6. Run `task publish:dry`. It must report the exact Day/title and `would-create`; any `already-published`, identity mismatch, stale URL, or unexpected draft is a hard stop.
7. Run the authorized publication workflow once. Verify the new public page independently: exact title, account, registered series, today's Taipei date, article body, and every expected image URL rendered as an image.
8. If publication may have succeeded but receipt synchronization reports a conflict with the immutable original receipt, do not publish again. Verify the public page, then create `articles/day-NNN/republication.json` recording the original and replacement IDs/URLs, replacement timestamp, reason, source/rendered hashes, image URLs, and verification result.
9. Commit and push only the lineage record and any skill or workflow changes. Keep authentication, runtime state, traces, screenshots, and HTML diagnostics ignored.

## Stop conditions

- Never delete more than the one explicitly authorized article.
- Never repeat deletion or publication when the site's result is uncertain.
- Do not delete and restart the whole series, change its title, or register another series without separate user authorization.
- If iThome refuses a same-day replacement or the series no longer accepts today's Day, preserve the evidence and report the platform state instead of improvising around contest rules.
