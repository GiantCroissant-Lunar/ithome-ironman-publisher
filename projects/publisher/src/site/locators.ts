import type { Locator, Page } from 'playwright';

// Keep every page-structure assumption here. These are conservative semantic/test-id
// candidates, not a claim that the current iT 邦 DOM has been verified.
export const selectorCatalog = {
  publicArticleCards: [
    '[data-testid*="article-card" i]',
    '[data-test*="article-card" i]',
    '.profile-list:not(:has(.title-badge--draft))',
    'main article',
  ],
  draftCards: [
    '[data-testid*="draft-card" i]',
    '[data-test*="draft-card" i]',
    '.profile-list:has(.title-badge--draft)',
    'main article',
  ],
  titleLinks: [
    '[data-testid*="title" i] a[href]',
    'a[data-testid*="title" i][href]',
    'a.qa-list__title-link[href]',
    'h1 a[href], h2 a[href], h3 a[href], h4 a[href]',
    'a[href*="/articles/"]',
  ],
  dateElements: [
    'time[datetime]',
    'time',
    'a.qa-list__info-time[title]',
    '[data-testid*="date" i]',
    '[data-test*="date" i]',
  ],
} as const;

export const emptyListingPattern = /尚無文章|沒有文章|目前沒有|no articles|no drafts|empty/iu;

export function draftsLinkCandidates(page: Page): Locator[] {
  return [
    page.getByRole('link', { name: /草稿|我的發文|draft|my posts/iu }),
    page.locator('a[href*="draft" i]'),
    page.locator('a[href^="/users/"][href$="/articles"]'),
  ];
}

export function newArticleLinkCandidates(page: Page): Locator[] {
  return [
    page.getByRole('link', { name: /鐵人發文|發表文章|寫文章|新增文章|new article|write/iu }),
    page.locator('a[href*="/ironman/create/" i]'),
    page.locator('a[href*="article" i][href*="new" i], a[href*="create" i]'),
  ];
}

export function loginCandidates(page: Page): Locator[] {
  return [
    page.getByRole('link', { name: /登入|sign[ -]?in|log[ -]?in/iu }),
    page.getByRole('button', { name: /登入|sign[ -]?in|log[ -]?in/iu }),
  ];
}

export function seriesLinkCandidates(page: Page, seriesTitle?: string): Locator[] {
  return [
    ...(seriesTitle ? [page.getByRole('link', { name: seriesTitle, exact: true })] : []),
    page.locator('a[href*="/users/"][href*="/ironman/"]'),
  ];
}

export function publishOptionsCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /^(?:發表|發布)(?:設定|選項|選單)$/u }),
    page.getByRole('button', { name: /^publish options$/iu }),
  ];
}

export function publishActionCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /^(?:發表|發布)文章$/u }),
    page.getByRole('menuitem', { name: /^(?:發表|發布)文章$/u }),
    page.getByRole('button', { name: /^publish article$/iu }),
    page.getByRole('menuitem', { name: /^publish article$/iu }),
  ];
}

export function confirmationCandidates(page: Page): Locator[] {
  return [
    page.getByRole('dialog').getByRole('button', { name: /^(?:確定|確認|確認發表|發表)$/u }),
    page.getByRole('dialog').getByRole('button', { name: /^(?:confirm|publish)$/iu }),
  ];
}

export function articleTitleInputCandidates(page: Page): Locator[] {
  return [
    page.getByRole('textbox', { name: /標題|title/iu }),
    page.getByLabel(/標題|title/iu),
    page.locator('input[name*="title" i]'),
    page.locator('input[placeholder*="標題" i]'),
  ];
}

export function markdownEditorCandidates(page: Page): Locator[] {
  return [
    page.getByRole('textbox', { name: /內容|正文|markdown|content/iu }),
    page.getByLabel(/內容|正文|markdown|content/iu),
    page.locator('textarea[name*="content" i], textarea[name*="description" i]'),
    page.locator('[contenteditable="true"][role="textbox"]'),
  ];
}

export function tagInputCandidates(page: Page): Locator[] {
  return [
    page.getByRole('textbox', { name: /標籤|tag/iu }),
    page.getByLabel(/標籤|tag/iu),
    page.locator('input[name*="tag" i]'),
  ];
}

export function saveDraftCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /^(?:儲存|保存|暫存)草稿$/u }),
    page.getByRole('button', { name: /^save draft$/iu }),
  ];
}

export function imageUploadCandidates(page: Page): Locator[] {
  return [
    page.locator('input[type="file"][accept*="image" i]'),
    page.getByLabel(/上傳圖片|圖片上傳|upload image/iu).locator('input[type="file"]'),
  ];
}

export async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (await item.isVisible()) {
        return item;
      }
    }
  }
  return undefined;
}
