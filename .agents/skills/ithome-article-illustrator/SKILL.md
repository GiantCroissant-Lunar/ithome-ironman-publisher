---
name: ithome-article-illustrator
description: Generate, review, and promote Leonardo.Ai illustrations for iT Ironman day-NNN articles in this repository. Use when an article needs a new visual, image variants, alt text, provenance, or generated-image validation; do not use it for draft synchronization or publication.
---

# iT Ironman article illustrator

Work from the repository root. Treat generated images as editorial assets with a paid external generation step, not as part of the unattended publishing scheduler.

## Boundary and authorization

- Read the target `articles/day-NNN/index.md`, nearby images, and the series context in `README.md` before proposing a visual.
- A real Leonardo generation consumes separate API credits. Call `generate-image` only when the user explicitly asks to generate or revise an image in the current request. Planning, configuring MCP, or discussing prompts is not authorization to spend credits.
- Never place the API key in a prompt, source file, manifest, log, or command output. The repository MCP config reads `LEONARDO_API_KEY` from the Codex process environment.
- Do not sync a draft or publish an article. Route those requests to `ithome-draft-sync` or `ithome-publish` after the chosen local image passes validation.

## Creative workflow

1. Run `task images:check DAY=N` to establish the current state. Read the article and identify what the image should explain, not merely decorate.
2. Draft a concrete prompt with composition, subject, lighting/color, aspect ratio, and exclusions. Avoid text embedded in the image unless it is essential; Chinese lettering in generated pixels is not a reliable source of truth.
3. Prefer Lucid Origin for editorial or conceptual visuals, Lucid Realism only when photorealism is the actual goal, and Ideogram 3.0 when a text-bearing design is explicitly required.
4. Generate a small, reviewable set of candidates. Keep unselected candidates under `infra/generated/day-NNN/<run-id>/`, which Git ignores. Do not silently decide between materially different candidates.
5. Present the candidates with their model, dimensions, and concise tradeoffs. Wait for the user's selection before changing the article source.
6. Download the selected result rather than leaving an expiring remote URL in Markdown. Promote it to a descriptive path under `articles/day-NNN/images/generated/` and reference that path from `index.md` with useful alt text.
7. Create or update `articles/day-NNN/images/generated/manifest.json`. Record provider, model, exact prompt, dimensions, generation time, optional generation ID, alt text, selected file path, and its SHA-256. A source URL is optional only when it is stable and has no credentials, signature/query parameters, or fragment. Do not record secrets or presigned download URLs.
8. Run `task images:check DAY=N`, then `task content:check`. Report the selected file, manifest, and resulting article `sourceHash`.

The TypeScript validator owns path safety, manifest schema, Markdown-reference coverage, and SHA-256 comparison. Do not replace those checks with ad-hoc skill scripts.
