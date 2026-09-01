import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { loadProjectEnvironment } from '../config/environment.js';
import { loadConfig } from '../config/schema.js';
import { errorDetails, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { PlaywrightPublisherSite } from '../site/playwright-publisher-site.js';

loadProjectEnvironment();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const browser = await chromium.launch({
    headless: false,
    ...(config.browserChannel === 'msedge' ? { channel: 'msedge' as const } : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const prompt = createInterface({ input, output });

  try {
    await page.goto(new URL('/', config.profileUrl).toString(), { waitUntil: 'domcontentloaded' });
    output.write('\n請在開啟的瀏覽器完成人工登入；完成後回到 iT 邦首頁。\n');
    await prompt.question(`確認頁首或導覽列看到帳號識別字「${config.userIdentifier}」後，回到這裡按 Enter… `);

    const authenticatedNavigation = page.locator('header, nav').filter({ hasText: config.userIdentifier });
    if ((await authenticatedNavigation.count()) === 0) {
      throw new Error(`找不到帳號識別字「${config.userIdentifier}」，登入狀態尚未儲存。`);
    }

    await mkdir(dirname(config.authStatePath), { recursive: true });
    await context.storageState({ path: config.authStatePath });
    await PlaywrightPublisherSite.protectAuthFile(config.authStatePath);
    logger.info(
      { authStatePath: config.authStatePath, browserChannel: config.browserChannel },
      'Authentication state saved; keep this file out of version control',
    );
  } finally {
    prompt.close();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
