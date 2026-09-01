import type { Locator, Page } from 'playwright';

export function leonardoSignInCandidates(page: Page): Locator[] {
  return [
    page.getByRole('link', { name: /^sign in$/iu }),
    page.getByRole('button', { name: /^sign in$/iu }),
    page.locator('a[href*="/auth/login" i]'),
  ];
}

export function leonardoPromptCandidates(page: Page): Locator[] {
  return [
    page.getByRole('textbox', { name: /prompt/iu }),
    page.getByPlaceholder(/type a prompt/iu),
    page.locator('textarea[placeholder*="prompt" i]'),
  ];
}

export function leonardoNegativePromptCandidates(page: Page): Locator[] {
  return [
    page.getByRole('textbox', { name: /negative prompt/iu }),
    page.getByPlaceholder(/negative prompt/iu),
    page.locator('textarea[aria-label*="negative prompt" i]'),
  ];
}

export function leonardoGenerateCandidates(page: Page): Locator[] {
  return [page.getByRole('button', { name: /^generate$/iu }), page.locator('button[aria-label="Generate"]')];
}

export function leonardoAspectRatioCandidates(page: Page): Locator[] {
  return [
    page.getByRole('combobox', { name: /aspect ratio/iu }),
    page.locator('[role="combobox"][aria-label*="Aspect ratio" i]'),
    page.getByRole('radio', { name: /^(?:\d+:\d+)$/u }),
  ];
}

export function leonardoStyleCandidates(page: Page): Locator[] {
  return [page.getByRole('combobox', { name: /style/iu }), page.locator('[role="combobox"][aria-label*="Style" i]')];
}

export function leonardoModelCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /model:?/iu }),
    page.locator('button[data-testid="model-selector-trigger"]'),
    page.locator('button[aria-label*="Model:" i]'),
  ];
}

export function leonardoQuantityCandidates(page: Page): Locator[] {
  return [
    page.getByRole('combobox', { name: /select quantity/iu }),
    page.locator('[role="combobox"][aria-label*="quantity" i]'),
  ];
}

export function leonardoDownloadCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /download/iu }),
    page.getByRole('link', { name: /download/iu }),
    page.locator('[aria-label*="Download" i]'),
  ];
}

export function leonardoSettingsCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /open settings/iu }),
    page.getByRole('button', { name: /^settings$/iu }),
    page.locator('button[aria-label*="settings" i]'),
  ];
}

export function leonardoGeneratedImageLinks(page: Page): Locator {
  return page.locator('a[href*="/generation/image/" i]');
}

export function leonardoKnownBlockingDialogs(page: Page): Locator {
  return page.locator('[role="dialog"][data-state="open"], [data-slot="dialog-content"][data-state="open"]');
}

export async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return undefined;
}

export async function firstEnabledVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if ((await item.isVisible().catch(() => false)) && (await item.isEnabled().catch(() => false))) return item;
    }
  }
  return undefined;
}
