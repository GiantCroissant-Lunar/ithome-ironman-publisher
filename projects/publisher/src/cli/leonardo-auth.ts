import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Page } from 'playwright';
import { loadProjectEnvironment } from '../config/environment.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { loadLeonardoConfig } from '../leonardo/config.js';
import { firstVisible, leonardoSignInCandidates } from '../leonardo/locators.js';

loadProjectEnvironment();

async function isAuthenticated(page: Page, expectedOrigin: string): Promise<boolean> {
  if (new URL(page.url()).origin !== expectedOrigin) return false;
  if (/\/auth\/login/iu.test(new URL(page.url()).pathname)) return false;
  return !(await firstVisible(leonardoSignInCandidates(page)));
}

async function main(): Promise<void> {
  const config = loadLeonardoConfig();
  const logger = createLogger(config.logLevel);
  await mkdir(config.authProfileDirectory, { recursive: true });
  await mkdir(dirname(config.authStatePath), { recursive: true });
  const context = await chromium.launchPersistentContext(config.authProfileDirectory, {
    headless: false,
    ...(config.browserChannel === 'msedge' ? { channel: 'msedge' as const } : {}),
  });
  let page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(config.homeUrl, { waitUntil: 'domcontentloaded' });
    const expectedOrigin = new URL(config.homeUrl).origin;
    process.stdout.write('\n請在專用 Edge 視窗登入 Leonardo；程式會在登入成功後自動保存 session。\n');
    const deadline = Date.now() + config.authTimeoutMs;
    while (Date.now() < deadline) {
      const leonardoPage = context.pages().find((candidate) => candidate.url().startsWith(expectedOrigin));
      if (leonardoPage) page = leonardoPage;
      if (await isAuthenticated(page, expectedOrigin)) {
        await page.goto(config.generateUrl, { waitUntil: 'domcontentloaded' });
        if (await isAuthenticated(page, expectedOrigin)) {
          await context.storageState({ path: config.authStatePath, indexedDB: true });
          if (process.platform !== 'win32') await chmod(config.authStatePath, 0o600);
          logger.info(
            { authStatePath: config.authStatePath, authProfileDirectory: config.authProfileDirectory },
            'Leonardo authentication state saved',
          );
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new AppError('Timed out waiting for Leonardo login', ExitCode.AuthenticationExpired, {
      authTimeoutMs: config.authTimeoutMs,
      pageUrl: page.url(),
    });
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
