---
name: ithome-article-author
description: Create or revise iT Ironman day-NNN Markdown articles and colocated images in this repository. Use for article drafting, frontmatter, timestamps, media references, or local content validation; do not use it to change drafts or publish on iT.
---

# iT Ironman article authoring

Work from the repository root. Treat `articles/day-NNN/index.md` and its colocated media as the source of truth.

## Boundary

- Put editorial judgment, Unity-orchestration series continuity, title/tag choices, and review decisions in this skill-driven workflow.
- Leave parsing, path safety, timestamp validation, image hashing, and canonical `sourceHash` calculation to the TypeScript implementation. Do not reproduce those mechanics in ad-hoc shell commands or skill scripts.
- Treat `articles/day-NNN/publication.json` as a generated, immutable Git receipt. Never create, rewrite, or delete it as part of article editing.
- Route requests to create or revise AI-generated article visuals through `ithome-article-illustrator`; it owns candidate review and provenance. Continue to treat the selected local file and manifest as article source.
- Do not open, create, update, or publish an iT draft. Route those requests to `ithome-draft-sync` or `ithome-publish`.

## Workflow

1. Read `README.md`, `articles/README.md`, and the target `articles/day-NNN/index.md` when it exists.
2. Preserve the series premise: the 30-day subject is moving from direct Unity Game Dev toward orchestration of Unity Game Dev, in the `Vibe Coding` category. Publishing automation is the Day 001 application, not the entire series.
3. Require strict frontmatter with `title`, RFC 3339 `timestamp` including an explicit offset, and one or more `tags`.
4. Keep local images inside the same `day-NNN` directory and reference them with relative Markdown paths. Never use `../`.
5. Create `images/visual-plan.json` for every article: one `hero` at the article start plus two or three inline slots attached to existing `##` sections. Route prompt creation, generation, review, and promotion to `ithome-article-illustrator`.
6. Run `task content:check`. Report the resulting `sourceHash`, planned/selected visual counts, and any validation errors.
7. Run the broader `task check` when article changes accompany application changes.

Changing a published article locally does not authorize editing the public post. The runtime policy is report-only until the user explicitly requests a public update workflow.
