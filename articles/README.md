# Article source format

Each article is an isolated directory named `day-NNN`:

```text
day-001/
  index.md
  ref-image-001.png
  images/
    visual-plan.json
    prompts/
      hero.json
      inline-01.json
      inline-02.json
      inline-03.json
    generated/
      hero.png
      manifest.json
  publication.json
```

`index.md` requires strict frontmatter:

```yaml
---
title: Article title
timestamp: "2026-09-01T10:17:00+08:00"
tags:
  - Playwright
  - TypeScript
---
```

`timestamp` is the earliest intended publication time and must be RFC 3339 with an explicit offset. Quote it so YAML preserves the original offset.

Every article requires `images/visual-plan.json`. It contains exactly one `hero` at `article-start` followed by two or three contiguous inline slots. Each inline slot names an existing level-two Markdown heading and references the matching canonical prompt filename:

```json
{
  "version": 1,
  "dayNumber": 1,
  "assets": [
    {
      "slot": "hero",
      "request": "./prompts/hero.json",
      "placement": { "kind": "article-start" }
    },
    {
      "slot": "inline-01",
      "request": "./prompts/inline-01.json",
      "placement": {
        "kind": "after-heading",
        "heading": "## First section"
      }
    },
    {
      "slot": "inline-02",
      "request": "./prompts/inline-02.json",
      "placement": {
        "kind": "after-heading",
        "heading": "## Second section"
      }
    }
  ]
}
```

`task content:check` validates the Day, slot order, request filenames, unique asset names, and inline headings. Generation requests are executed one at a time so validating or editing the plan never consumes Leonardo tokens.

Reference local images with a path relative to the same `day-NNN` directory:

```markdown
![Description](./ref-image-001.png)
```

Local image paths may not escape the directory. Only referenced assets are part of the canonical SHA-256 source hash and upload plan. Each asset also has its own SHA-256 so unchanged images can reuse their hosted URL.

Leonardo-generated candidates remain in the Git-ignored `infra/generated/day-NNN/<run-id>/` area until a human selects one. Promote only the selected file to `images/generated/`, reference it from `index.md`, and record its provenance in `images/generated/manifest.json`:

```json
{
  "version": 1,
  "provider": "leonardo-ai",
  "assets": [
    {
      "path": "./images/generated/hero.png",
      "sha256": "<64 lowercase hexadecimal characters>",
      "slot": "hero",
      "generationId": "<optional Leonardo generation ID>",
      "model": "Lucid Origin",
      "prompt": "<exact generation prompt>",
      "width": 1536,
      "height": 1024,
      "generatedAt": "2026-09-01T12:00:00+08:00",
      "sourceUrl": "https://<optional stable URL without query parameters>",
      "alt": "Useful description of the selected visual"
    }
  ]
}
```

Every manifest asset must be referenced by Markdown, and every Markdown image under `images/generated/` must appear in the manifest. Validate one day with `task images:check DAY=1`; the full `task content:check` applies the same check to all articles.

`publication.json` is an immutable, Git-tracked receipt generated only after the public article is verified. It records the iT article ID and URL, series identity, publication time, and the source/rendered hashes used for publication. Do not create or edit it by hand. A later local content change may cause a reported hash drift, but it never rewrites the receipt or authorizes a public edit.
