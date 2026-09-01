# Article source format

Each article is an isolated directory named `day-NNN`:

```text
day-001/
  index.md
  ref-image-001.png
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

Reference local images with a path relative to the same `day-NNN` directory:

```markdown
![Description](./ref-image-001.png)
```

Local image paths may not escape the directory. Only referenced assets are part of the canonical SHA-256 source hash and upload plan. Each asset also has its own SHA-256 so unchanged images can reuse their hosted URL.

`publication.json` is an immutable, Git-tracked receipt generated only after the public article is verified. It records the iT article ID and URL, series identity, publication time, and the source/rendered hashes used for publication. Do not create or edit it by hand. A later local content change may cause a reported hash drift, but it never rewrites the receipt or authorizes a public edit.
