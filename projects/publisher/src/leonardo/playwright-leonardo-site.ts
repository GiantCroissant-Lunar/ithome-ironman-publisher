import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Download, type Locator, type Page } from 'playwright';
import type { Logger } from 'pino';
import { AppError, errorDetails, ExitCode } from '../infra/errors.js';
import type { LeonardoConfig } from './config.js';
import type { LeonardoGenerationRequest } from './generation-request.js';
import {
  createRunRecord,
  normalizedDownloadedExtension,
  recordCandidate,
  type DownloadedCandidate,
  type LeonardoGenerationRun,
} from './generation-run.js';
import type { LeonardoGenerator } from './generation-workflow.js';
import {
  firstEnabledVisible,
  firstVisible,
  leonardoAspectRatioCandidates,
  leonardoDownloadCandidates,
  leonardoGenerateCandidates,
  leonardoGeneratedImageLinks,
  leonardoKnownBlockingDialogs,
  leonardoModelCandidates,
  leonardoNegativePromptCandidates,
  leonardoPromptCandidates,
  leonardoQuantityCandidates,
  leonardoSettingsCandidates,
  leonardoSignInCandidates,
  leonardoStyleCandidates,
} from './locators.js';

export interface LeonardoProbe {
  capturedAt: string;
  pageUrl: string;
  pageTitle: string;
  controls: Array<{
    tag: string;
    role: string | null;
    ariaLabel: string | null;
    placeholder: string | null;
    text: string;
    disabled: boolean;
    testId: string | null;
  }>;
  semanticControls: {
    prompt: boolean;
    generate: boolean;
    aspectRatio: boolean;
    style: boolean;
    model: boolean;
  };
}

export class PlaywrightLeonardoSite implements LeonardoGenerator {
  private tracingStarted = false;
  private diagnosticDirectory: string | undefined;

  private constructor(
    private readonly config: LeonardoConfig,
    private readonly logger: Logger,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  public static async create(config: LeonardoConfig, logger: Logger): Promise<PlaywrightLeonardoSite> {
    try {
      await access(config.authStatePath, constants.R_OK);
    } catch {
      throw new AppError('Leonardo authentication state is missing. Run `task leonardo:auth` first.', ExitCode.AuthenticationExpired, {
        authStatePath: config.authStatePath,
      });
    }
    const browser = await chromium.launch({
      headless: config.headless,
      ...(config.browserChannel === 'msedge' ? { channel: 'msedge' as const } : {}),
    });
    const context = await browser.newContext({ storageState: config.authStatePath, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    const site = new PlaywrightLeonardoSite(config, logger, browser, context, page);
    if (config.traceMode !== 'off') {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      site.tracingStarted = true;
    }
    return site;
  }

  public async assertAuthenticated(): Promise<void> {
    await this.page.goto(this.config.generateUrl, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + this.config.navigationTimeoutMs;
    while (Date.now() < deadline) {
      const login = await firstVisible(leonardoSignInCandidates(this.page));
      const redirectedToLogin = /\/auth\/login/iu.test(new URL(this.page.url()).pathname);
      if (login || redirectedToLogin) {
        throw new AppError('Leonardo session is missing or expired. Run `task leonardo:auth` again.', ExitCode.AuthenticationExpired, {
          pageUrl: this.page.url(),
        });
      }
      if (await firstVisible(leonardoPromptCandidates(this.page))) return;
      await this.page.waitForTimeout(500);
    }
    throw new AppError('Leonardo generation UI did not finish loading', ExitCode.BrowserWorkflowFailed, {
      pageUrl: this.page.url(),
      navigationTimeoutMs: this.config.navigationTimeoutMs,
    });
  }

  public async captureProbe(): Promise<{ directory: string; probe: LeonardoProbe }> {
    await this.assertAuthenticated();
    await this.dismissKnownBlockingDialogs();
    const controls = await this.page.locator('button, [role="combobox"], input, textarea').evaluateAll((elements) =>
      elements
        .map((element) => ({
          tag: element.tagName,
          role: element.getAttribute('role'),
          ariaLabel: element.getAttribute('aria-label'),
          placeholder: element.getAttribute('placeholder'),
          text: (element.textContent ?? '').trim().slice(0, 200),
          disabled: element.hasAttribute('disabled'),
          testId: element.getAttribute('data-testid'),
        }))
        .filter((control) => control.ariaLabel || control.placeholder || control.text),
    );
    const probe: LeonardoProbe = {
      capturedAt: new Date().toISOString(),
      pageUrl: this.page.url(),
      pageTitle: await this.page.title(),
      controls,
      semanticControls: {
        prompt: Boolean(await firstVisible(leonardoPromptCandidates(this.page))),
        generate: Boolean(await firstVisible(leonardoGenerateCandidates(this.page))),
        aspectRatio: Boolean(await firstVisible(leonardoAspectRatioCandidates(this.page))),
        style: Boolean(await firstVisible(leonardoStyleCandidates(this.page))),
        model: Boolean(await firstVisible(leonardoModelCandidates(this.page))),
      },
    };
    const directory = await this.getDiagnosticDirectory();
    await Promise.all([
      writeFile(join(directory, 'probe.json'), `${JSON.stringify(probe, undefined, 2)}\n`, 'utf8'),
      writeFile(join(directory, 'probe.html'), await this.page.content(), 'utf8'),
      this.page.screenshot({ path: join(directory, 'probe.png'), fullPage: true }),
    ]);
    this.logger.info({ directory, pageUrl: probe.pageUrl, semanticControls: probe.semanticControls }, 'Leonardo UI probe captured');
    return { directory, probe };
  }

  public async generate(request: LeonardoGenerationRequest): Promise<LeonardoGenerationRun> {
    await this.assertAuthenticated();
    await this.dismissKnownBlockingDialogs();
    const prompt = await firstEnabledVisible(leonardoPromptCandidates(this.page));
    if (!prompt) {
      throw new AppError('Leonardo prompt control could not be located', ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
      });
    }

    await prompt.fill(request.prompt);
    await this.setAspectRatio(request.aspectRatio);
    await this.setChoice(leonardoStyleCandidates(this.page), request.style, 'style');
    await this.setChoice(leonardoModelCandidates(this.page), request.model, 'model');
    await this.setQuantity(request.maxCandidates);
    await this.setNegativePrompt(request.negativePrompt);

    const beforeLinks = new Set(await this.generatedImageHrefs());
    const runId = new Date().toISOString().replaceAll(/[:.]/gu, '-');
    const runDirectory = join(
      this.config.outputDirectory,
      `day-${String(request.dayNumber).padStart(3, '0')}`,
      runId,
    );
    await mkdir(runDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(runDirectory, 'request.json'), `${JSON.stringify(request, undefined, 2)}\n`, 'utf8'),
      this.page.screenshot({ path: join(runDirectory, 'before-generate.png'), fullPage: true }),
    ]);

    const generate = await firstEnabledVisible(leonardoGenerateCandidates(this.page));
    if (!generate) {
      throw new AppError('Leonardo Generate control is missing or disabled after the request was prepared', ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
      });
    }

    this.logger.info(
      {
        dayNumber: request.dayNumber,
        assetName: request.assetName,
        model: request.model,
        style: request.style,
        aspectRatio: request.aspectRatio,
      },
      'Submitting one Leonardo Web generation; website tokens may be consumed',
    );
    await generate.click();
    const resultUrls = await this.waitForGeneratedResults(beforeLinks, request.prompt);
    const selectedUrls = resultUrls.slice(0, request.maxCandidates);
    const downloaded: DownloadedCandidate[] = [];
    for (const [index, resultUrl] of selectedUrls.entries()) {
      downloaded.push(await this.downloadCandidate(resultUrl, runDirectory, index + 1));
    }

    const candidates = await Promise.all(
      downloaded.map((candidate, index) => recordCandidate(runDirectory, index + 1, candidate)),
    );
    const run = createRunRecord(runId, new Date().toISOString(), this.page.url(), request, candidates);
    await Promise.all([
      writeFile(join(runDirectory, 'run.json'), `${JSON.stringify(run, undefined, 2)}\n`, 'utf8'),
      this.page.screenshot({ path: join(runDirectory, 'after-generate.png'), fullPage: true }),
    ]);
    this.logger.info({ runDirectory, candidates: candidates.length }, 'Leonardo candidates downloaded and recorded');
    return run;
  }

  public async captureDiagnostics(error: unknown): Promise<string> {
    const directory = await this.getDiagnosticDirectory();
    await Promise.allSettled([
      this.page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }),
      this.page.content().then((html) => writeFile(join(directory, 'failure.html'), html, 'utf8')),
      writeFile(
        join(directory, 'failure.json'),
        `${JSON.stringify({ capturedAt: new Date().toISOString(), pageUrl: this.page.url(), ...errorDetails(error) }, undefined, 2)}\n`,
        'utf8',
      ),
    ]);
    this.logger.error({ diagnosticDirectory: directory }, 'Leonardo failure diagnostics captured');
    return directory;
  }

  public async close(failed: boolean): Promise<void> {
    try {
      if (this.tracingStarted) {
        const retain = this.config.traceMode === 'always' || (this.config.traceMode === 'retain-on-failure' && failed);
        if (retain) {
          const directory = await this.getDiagnosticDirectory();
          await this.context.tracing.stop({ path: join(directory, 'trace.zip') });
        } else {
          await this.context.tracing.stop();
        }
      }
    } finally {
      await this.browser.close();
    }
  }

  private async getDiagnosticDirectory(): Promise<string> {
    if (!this.diagnosticDirectory) {
      const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
      this.diagnosticDirectory = join(this.config.diagnosticsDirectory, timestamp);
      await mkdir(this.diagnosticDirectory, { recursive: true });
    }
    return this.diagnosticDirectory;
  }

  private async setChoice(candidates: Locator[], value: string, controlName: string): Promise<void> {
    const control = await firstEnabledVisible(candidates);
    if (!control) {
      throw new AppError(`Leonardo ${controlName} control could not be located`, ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
        expectedValue: value,
      });
    }
    const current = [await control.getAttribute('aria-label'), await control.inputValue().catch(() => ''), await control.textContent()]
      .filter(Boolean)
      .join(' ');
    if (normalizedText(current).includes(normalizedText(value))) return;

    if ((await control.evaluate((element) => element.tagName.toLowerCase())) === 'select') {
      await control.selectOption({ label: value });
      return;
    }
    await control.click();
    const exact = new RegExp(`^\\s*${escapeRegularExpression(value)}\\s*$`, 'iu');
    const option = await firstEnabledVisible([
      this.page.getByRole('option', { name: exact }),
      this.page.getByRole('menuitem', { name: exact }),
      this.page.getByRole('button', { name: exact }),
      this.page.getByText(exact),
    ]);
    if (!option) {
      throw new AppError(`Leonardo ${controlName} option could not be located`, ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
        expectedValue: value,
      });
    }
    await option.click();
  }

  private async dismissKnownBlockingDialogs(): Promise<void> {
    // Leonardo mounts its changelog/onboarding dialog shortly after the generation shell.
    await this.page.waitForTimeout(1_500);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dialogs = leonardoKnownBlockingDialogs(this.page);
      const count = await dialogs.count();
      let dismissed = false;
      for (let index = 0; index < count; index += 1) {
        const dialog = dialogs.nth(index);
        if (!(await dialog.isVisible().catch(() => false))) continue;
        const dialogText = await dialog.innerText().catch(() => '');
        if (!/(?:what'?s new|get started|ai creation introduction)/iu.test(dialogText)) continue;
        const close = await firstEnabledVisible([
          dialog.getByRole('button', { name: /^close$/iu }),
          dialog.locator('button[aria-label="Close" i]'),
        ]);
        if (!close) {
          throw new AppError('A recognized Leonardo onboarding dialog has no testable Close control', ExitCode.BrowserWorkflowFailed, {
            pageUrl: this.page.url(),
          });
        }
        await close.click();
        await dialog.waitFor({ state: 'hidden', timeout: this.config.actionTimeoutMs });
        this.logger.info({ dialogTitle: dialogText.split('\n')[0] }, 'Dismissed a known Leonardo onboarding dialog');
        dismissed = true;
        break;
      }
      if (!dismissed) return;
    }
  }

  private async setAspectRatio(value: string): Promise<void> {
    const exact = new RegExp(`^\\s*${escapeRegularExpression(value)}\\s*$`, 'iu');
    const directOption = await firstEnabledVisible([
      this.page.getByRole('radio', { name: exact }),
      this.page.getByRole('button', { name: exact }),
    ]);
    if (directOption) {
      if ((await directOption.getAttribute('aria-checked')) !== 'true') await directOption.click();
      return;
    }
    await this.setChoice(leonardoAspectRatioCandidates(this.page), value, 'aspect ratio');
  }

  private async setQuantity(value: number): Promise<void> {
    const exact = new RegExp(`^\\s*${String(value)}\\s*$`, 'u');
    const selected = await firstVisible([
      this.page.locator('button[aria-pressed="true"]').filter({ hasText: exact }),
      this.page.locator('[role="option"][aria-selected="true"]').filter({ hasText: exact }),
    ]);
    if (selected) return;
    const directOption = await firstEnabledVisible([
      this.page.locator('button[aria-pressed]').filter({ hasText: exact }),
      this.page.getByRole('radio', { name: exact }),
    ]);
    if (directOption) {
      await directOption.click();
      return;
    }
    await this.setChoice(leonardoQuantityCandidates(this.page), String(value), 'quantity');
  }

  private async setNegativePrompt(value: string | undefined): Promise<void> {
    if (!value) return;
    let control = await firstEnabledVisible(leonardoNegativePromptCandidates(this.page));
    if (!control) {
      const settings = await firstEnabledVisible(leonardoSettingsCandidates(this.page));
      if (settings) {
        await settings.click();
        control = await firstEnabledVisible(leonardoNegativePromptCandidates(this.page));
      }
    }
    if (!control) {
      throw new AppError('This Leonardo UI does not expose a testable negative-prompt control', ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
      });
    }
    await control.fill(value);
  }

  private async generatedImageHrefs(): Promise<string[]> {
    const hrefs = await leonardoGeneratedImageLinks(this.page).evaluateAll((links) =>
      links.map((link) => (link instanceof HTMLAnchorElement ? link.href : '')).filter(Boolean),
    );
    return [...new Set(hrefs)];
  }

  private async waitForGeneratedResults(beforeLinks: ReadonlySet<string>, prompt: string): Promise<string[]> {
    const deadline = Date.now() + this.config.generationTimeoutMs;
    while (Date.now() < deadline) {
      if (/\/auth\/login/iu.test(new URL(this.page.url()).pathname) || (await firstVisible(leonardoSignInCandidates(this.page)))) {
        throw new AppError('Leonardo session expired while generation was running', ExitCode.AuthenticationExpired, {
          pageUrl: this.page.url(),
        });
      }
      const links = await this.generatedImageHrefs();
      const newLinks = links.filter((href) => !beforeLinks.has(href));
      if (newLinks.length > 0) return newLinks;

      const matchingLinks = await leonardoGeneratedImageLinks(this.page)
        .evaluateAll(
          (elements, expectedPrompt) => {
            const normalize = (value: string): string =>
              value.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
            return elements
              .filter((element) => normalize(element.textContent ?? '').includes(normalize(expectedPrompt).slice(0, 80)))
              .map((element) => (element instanceof HTMLAnchorElement ? element.href : ''))
              .filter(Boolean);
          },
          prompt,
        )
        .catch(() => []);
      const newMatchingLinks = matchingLinks.filter((href) => !beforeLinks.has(href));
      if (newMatchingLinks.length > 0) return [...new Set(newMatchingLinks)];

      await this.page.waitForTimeout(1_000);
    }

    if (await firstVisible(leonardoDownloadCandidates(this.page))) return [this.page.url()];
    throw new AppError('Leonardo did not expose a completed generated image before the timeout', ExitCode.BrowserWorkflowFailed, {
      pageUrl: this.page.url(),
      generationTimeoutMs: this.config.generationTimeoutMs,
    });
  }

  private async downloadCandidate(resultUrl: string, directory: string, index: number): Promise<DownloadedCandidate> {
    if (this.page.url() !== resultUrl) {
      await this.page.goto(resultUrl, { waitUntil: 'domcontentloaded' });
    }
    const dimensions = await this.waitForLargestImage();
    const downloadControl = await firstEnabledVisible(leonardoDownloadCandidates(this.page));
    if (!downloadControl) {
      throw new AppError('Leonardo result page did not expose a Download control', ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
      });
    }

    let download = await this.captureDownload(() => downloadControl.click(), 4_000);
    if (!download) {
      const menuDownload = await firstEnabledVisible([
        this.page.getByRole('menuitem', { name: /download/iu }),
        this.page.getByRole('button', { name: /download (?:image|original)/iu }),
        this.page.getByRole('link', { name: /download (?:image|original)/iu }),
      ]);
      if (menuDownload && menuDownload !== downloadControl) {
        download = await this.captureDownload(() => menuDownload.click(), this.config.actionTimeoutMs);
      }
    }
    if (!download) {
      throw new AppError('Leonardo Download control did not start a browser download', ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
      });
    }

    const extension = normalizedDownloadedExtension(download.suggestedFilename());
    const fileName = `candidate-${String(index).padStart(2, '0')}${extension}`;
    await download.saveAs(join(directory, fileName));
    const sourceUrl = this.page.url();
    const generationId = extractGenerationId(sourceUrl);
    return {
      fileName,
      width: dimensions.width,
      height: dimensions.height,
      ...(generationId ? { generationId } : {}),
      ...(sourceUrl.startsWith('https://app.leonardo.ai/') ? { sourceUrl } : {}),
    };
  }

  private async waitForLargestImage(): Promise<{ width: number; height: number }> {
    const deadline = Date.now() + this.config.actionTimeoutMs;
    while (Date.now() < deadline) {
      const images = await this.page.locator('main img, [role="main"] img, img').evaluateAll((elements) =>
        elements
          .filter((element): element is HTMLImageElement => element instanceof HTMLImageElement && element.complete)
          .map((element) => ({ width: element.naturalWidth, height: element.naturalHeight }))
          .filter((dimensions) => dimensions.width >= 256 && dimensions.height >= 256)
          .sort((left, right) => right.width * right.height - left.width * left.height),
      );
      const largest = images[0];
      if (largest) return largest;
      await this.page.waitForTimeout(500);
    }
    throw new AppError('Leonardo result image dimensions could not be verified', ExitCode.BrowserWorkflowFailed, {
      pageUrl: this.page.url(),
    });
  }

  private async captureDownload(action: () => Promise<void>, timeout: number): Promise<Download | undefined> {
    const waiting = this.page.waitForEvent('download', { timeout }).catch(() => undefined);
    await action();
    return waiting;
  }
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function escapeRegularExpression(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractGenerationId(url: string): string | undefined {
  const match = /([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\/)?(?:[?#].*)?$/iu.exec(url);
  return match?.[1];
}
