---
name: ithome-article-illustrator
description: Generate, review, and promote Leonardo.Ai illustrations for iT Ironman day-NNN articles in this repository. Use when an article needs a new visual, image variants, alt text, provenance, or generated-image validation; do not use it for draft synchronization or publication.
---

# iT Ironman article illustrator

Work from the repository root. Treat generated images as editorial assets that consume Leonardo Web tokens, not as part of the unattended publishing scheduler.

## Boundary and authorization

- Read the target `articles/day-NNN/index.md`, nearby images, and the series context in `README.md` before proposing a visual.
- A real generation consumes the user's Leonardo web-app token allowance. Run the final Generate action only when the user explicitly asks to generate or revise an image in the current request. Planning, probing, configuring MCP, or discussing prompts is not authorization to spend tokens.
- Use the dedicated Edge session created by `task leonardo:auth`. Do not access a daily browser profile, extract cookies, call undocumented HTTP/GraphQL endpoints, enable stealth/evasion, or bypass CAPTCHA or security controls.
- Do not sync a draft or publish an article. Route those requests to `ithome-draft-sync` or `ithome-publish` after the chosen local image passes validation.

## Creative workflow

1. Run `task images:check DAY=N` to establish the current state. Read the article and identify what the image should explain, not merely decorate.
2. Draft a concrete prompt with composition, subject, lighting/color, aspect ratio, and exclusions in a tracked `articles/day-NNN/images/prompts/<asset>.json` request. Avoid text embedded in the image unless it is essential; Chinese lettering in generated pixels is not a reliable source of truth.
3. Use `task leonardo:probe` when the live UI or selectors have changed. Playwright MCP is for read-only exploration and selector repair; the TypeScript CLI owns repeatable generation and diagnostics.
4. Run `task leonardo:preview REQUEST=<request.json>` first. Only with current explicit authorization, run `task leonardo:generate REQUEST=<request.json>` once through the visible Leonardo Web UI. Keep unselected candidates under `infra/generated/day-NNN/<run-id>/`, which Git ignores. Do not silently decide between materially different candidates.
5. Present the candidates with their model, dimensions, and concise tradeoffs. Wait for the user's selection before changing the article source.
6. Reference the selected canonical `./images/generated/<name>.<ext>` path from `index.md` with useful alt text, then run `task leonardo:promote RUN=<run.json> CANDIDATE=N NAME=<name>.<ext>`. The CLI verifies and copies the browser-downloaded result; never leave an expiring remote URL in Markdown.
7. Let promotion create or update `articles/day-NNN/images/generated/manifest.json`. It records provider, model, exact prompt, dimensions, generation time, optional generation ID, alt text, selected file path, and SHA-256. A source URL is included only when stable and free of credentials, signature/query parameters, and fragments. Do not record secrets or presigned download URLs.
8. Run `task images:check DAY=N`, then `task content:check`. Report the selected file, manifest, and resulting article `sourceHash`.

The TypeScript validator owns path safety, manifest schema, Markdown-reference coverage, and SHA-256 comparison. Do not replace those checks with ad-hoc skill scripts.
