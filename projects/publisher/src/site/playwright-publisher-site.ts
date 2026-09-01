import { constants } from 'node:fs';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/schema.js';
import { renderArticleWithAssets, type LocalArticle } from '../content/article.js';
import { parsePublicationDate, type CalendarDate } from '../domain/date.js';
import { titlesMatch } from '../domain/title.js';
import { AppError, ExitCode, errorDetails } from '../infra/errors.js';
import type {
  ArticleAssetState,
  ArticleRuntimeState,
  DiscoveredSiteState,
  PublisherRuntimeState,
} from '../state/publisher-state.js';
import {
  articleTitleInputCandidates,
  confirmationCandidates,
  draftsLinkCandidates,
  emptyListingPattern,
  firstVisible,
  imageUploadCandidates,
  imageUploadDialogCandidates,
  loginCandidates,
  markdownEditorCandidates,
  newArticleLinkCandidates,
  publishActionCandidates,
  publishOptionsCandidates,
  saveDraftCandidates,
  selectorCatalog,
  seriesLinkCandidates,
  tagInputCandidates,
} from './locators.js';
import type {
  DraftArticle,
  DraftSyncResult,
  PublicArticle,
  PublicArticleSnapshot,
  PublisherSite,
} from './publisher-site.js';

export class PlaywrightPublisherSite implements PublisherSite {
  private tracingStarted = false;
  private diagnosticDirectory: string | undefined;
  private readonly discovered: DiscoveredSiteState;

  private constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    runtimeState: PublisherRuntimeState,
  ) {
    this.discovered = {
      ...(runtimeState.seriesUrl ? { seriesUrl: runtimeState.seriesUrl } : {}),
      ...(runtimeState.draftsUrl ? { draftsUrl: runtimeState.draftsUrl } : {}),
      ...(runtimeState.newArticleUrl ? { newArticleUrl: runtimeState.newArticleUrl } : {}),
      ...(config.seriesUrl ? { seriesUrl: config.seriesUrl } : {}),
      ...(config.draftsUrl ? { draftsUrl: config.draftsUrl } : {}),
      ...(config.newArticleUrl ? { newArticleUrl: config.newArticleUrl } : {}),
    };
  }

  public static async create(
    config: AppConfig,
    logger: Logger,
    runtimeState: PublisherRuntimeState = { version: 1, profileUrl: config.profileUrl, articles: {} },
  ): Promise<PlaywrightPublisherSite> {
    try {
      await access(config.authStatePath, constants.R_OK);
    } catch {
      throw new AppError(
        'Authentication state is missing. Run `npm run auth` first.',
        ExitCode.AuthenticationExpired,
        { authStatePath: config.authStatePath },
      );
    }

    const browser = await chromium.launch({
      headless: config.headless,
      ...(config.browserChannel === 'msedge' ? { channel: 'msedge' as const } : {}),
    });
    const context = await browser.newContext({ storageState: config.authStatePath });
    const page = await context.newPage();
    page.setDefaultTimeout(config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    const site = new PlaywrightPublisherSite(config, logger, browser, context, page, runtimeState);
    if (config.traceMode !== 'off') {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      site.tracingStarted = true;
    }
    return site;
  }

  public async assertAuthenticated(): Promise<void> {
    await this.navigate(new URL('/', this.config.profileUrl).toString());
    const redirectedToLogin = /(?:login|sign-in|signin)/iu.test(new URL(this.page.url()).pathname);
    const login = await firstVisible(loginCandidates(this.page));
    const accountRegion = this.page.locator('header, nav').filter({ hasText: this.config.userIdentifier });
    if (redirectedToLogin || login || (await accountRegion.count()) === 0) {
      throw new AppError(
        'The saved session is expired or the configured user identifier is not visible in authenticated navigation. Run `npm run auth` again.',
        ExitCode.AuthenticationExpired,
        { currentUrl: this.page.url(), userIdentifier: this.config.userIdentifier },
      );
    }
    await this.discoverAuthenticatedNavigation();
  }

  public async getPublicArticleSnapshot(today: CalendarDate): Promise<PublicArticleSnapshot> {
    const listingUrl = this.discovered.seriesUrl ?? (await this.discoverProfileArticlesUrl());
    await this.navigate(listingUrl);
    if (this.discovered.seriesUrl && this.config.seriesTitle) {
      await this.assertExpectedIdentity('public series page', this.config.seriesTitle);
    } else {
      await this.assertExpectedIdentity('public user articles page', this.config.userIdentifier);
    }
    const cards = await this.firstNonEmptySelector(selectorCatalog.publicArticleCards);
    if (!cards) {
      const emptyStateVisible = await this.page.getByText(emptyListingPattern).first().isVisible().catch(() => false);
      return { articles: [], listingRecognized: emptyStateVisible, dateEvidenceComplete: emptyStateVisible };
    }
    const articles: PublicArticle[] = [];
    for (let index = 0; index < (await cards.count()); index += 1) {
      const card = cards.nth(index);
      const { title, url } = await this.readTitleAndUrl(card);
      const publishedDate = await this.readPublicationDate(card, today);
      articles.push(publishedDate ? { title, url, publishedDate } : { title, url });
    }
    return {
      articles,
      listingRecognized: true,
      dateEvidenceComplete: articles.every((article) => article.publishedDate !== undefined),
    };
  }

  public async listDrafts(): Promise<DraftArticle[]> {
    await this.navigate(await this.requireAuthenticatedUrl('drafts'));
    await this.assertExpectedIdentity('draft listing', this.config.userIdentifier);
    const cards = await this.firstNonEmptySelector(selectorCatalog.draftCards);
    if (!cards) {
      const emptyStateVisible = await this.page.getByText(emptyListingPattern).first().isVisible().catch(() => false);
      if (emptyStateVisible) return [];
      throw new AppError(
        'The draft listing could not be recognized. Capture selectors with Playwright codegen before publishing.',
        ExitCode.BrowserWorkflowFailed,
        { pageUrl: this.page.url() },
      );
    }
    const drafts: DraftArticle[] = [];
    for (let index = 0; index < (await cards.count()); index += 1) {
      drafts.push(await this.readTitleAndUrl(cards.nth(index)));
    }
    return drafts;
  }

  public async syncDraft(
    article: LocalArticle,
    existingDraft: DraftArticle | undefined,
    previousState?: ArticleRuntimeState,
  ): Promise<DraftSyncResult> {
    const action = existingDraft ? 'updated' : 'created';
    await this.navigate(existingDraft?.url ?? (await this.requireAuthenticatedUrl('newArticle')));
    await this.assertExpectedIdentity('article editor', this.config.userIdentifier);
    if (this.config.seriesTitle) await this.assertExpectedIdentity('article editor', this.config.seriesTitle);
    if (this.config.seriesCategory) await this.assertExpectedIdentity('article editor', this.config.seriesCategory);

    const titleInput = await firstVisible(articleTitleInputCandidates(this.page));
    const editor = await firstVisible(markdownEditorCandidates(this.page));
    if (!titleInput || !editor) {
      throw new AppError(
        'The article title or Markdown editor could not be found using semantic locators',
        ExitCode.BrowserWorkflowFailed,
        { pageUrl: this.page.url() },
      );
    }
    await titleInput.fill(article.title);

    const assets: Record<string, ArticleAssetState> = {};
    let uploadedImages = 0;
    for (const image of article.images) {
      const prior = previousState?.assets[image.markdownReference];
      if (prior?.sha256 === image.sha256) {
        assets[image.markdownReference] = prior;
        continue;
      }
      let uploadInput = await this.firstExisting(imageUploadCandidates(this.page));
      if (!uploadInput) {
        const openUploadDialog = await firstVisible(imageUploadDialogCandidates(this.page));
        if (openUploadDialog) {
          await openUploadDialog.click();
          uploadInput = await this.waitForExisting(imageUploadCandidates(this.page));
        }
      }
      if (!uploadInput) {
        throw new AppError('The image upload input could not be found', ExitCode.BrowserWorkflowFailed, {
          imagePath: image.absolutePath,
          pageUrl: this.page.url(),
        });
      }
      const knownUrls = new Set(extractHttpUrls(await this.readEditableValue(editor)));
      await uploadInput.setInputFiles(image.absolutePath);
      const remoteUrl = await this.waitForUploadedUrl(editor, knownUrls);
      assets[image.markdownReference] = { sha256: image.sha256, remoteUrl };
      uploadedImages += 1;
    }
    const rendered = renderArticleWithAssets(article, assets);
    await this.fillEditableValue(editor, rendered.markdown);

    await this.setArticleTags(article.tags);
    const saveDraft = await firstVisible(saveDraftCandidates(this.page));
    if (!saveDraft) {
      throw new AppError('A semantic save-draft control could not be found', ExitCode.BrowserWorkflowFailed, {
        pageUrl: this.page.url(),
      });
    }
    await saveDraft.click();
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);

    const savedTitle = await this.readEditableValue(titleInput);
    const savedMarkdown = await this.readEditableValue(editor);
    const savedTags = await this.readSelectedTags();
    const missingTags = savedTags ? article.tags.filter((tag) => !savedTags.includes(tag)) : [];
    if (
      !titlesMatch(savedTitle, article.title) ||
      normalizeMarkdown(savedMarkdown) !== normalizeMarkdown(rendered.markdown) ||
      missingTags.length > 0
    ) {
      throw new AppError('The saved draft could not be verified against the local article', ExitCode.VerificationFailed, {
        expectedTitle: article.title,
        sourceHash: article.sourceHash,
        renderedHash: rendered.renderedHash,
        missingTags,
        pageUrl: this.page.url(),
      });
    }
    return {
      action,
      uploadedImages,
      sourceHash: article.sourceHash,
      renderedHash: rendered.renderedHash,
      assets,
      draft: { title: article.title, url: this.page.url() },
    };
  }

  public async publishDraft(draft: DraftArticle): Promise<void> {
    await this.navigate(draft.url);
    await this.assertExpectedIdentity('draft editor', this.config.userIdentifier);
    if (this.config.seriesTitle) await this.assertExpectedIdentity('draft editor', this.config.seriesTitle);
    if (this.config.seriesCategory) await this.assertExpectedIdentity('draft editor', this.config.seriesCategory);
    const titleInput = await firstVisible(articleTitleInputCandidates(this.page));
    const editorTitle = titleInput ? await this.readEditableValue(titleInput) : '';
    const exactTitle = await this.page.getByText(draft.title, { exact: true }).first().isVisible().catch(() => false);
    if (!exactTitle && !titlesMatch(editorTitle, draft.title)) {
      throw new AppError('The selected draft title is not visible in the editor; refusing to publish', ExitCode.SafetyConflict, {
        expectedTitle: draft.title,
        pageUrl: this.page.url(),
      });
    }
    const options = await firstVisible(publishOptionsCandidates(this.page));
    if (options) await options.click();
    const publish = await firstVisible(publishActionCandidates(this.page));
    if (!publish) {
      throw new AppError(
        'A semantic publish control was not found. Update centralized locators after inspecting the live page.',
        ExitCode.BrowserWorkflowFailed,
        { pageUrl: this.page.url() },
      );
    }
    await publish.click();
    const confirm = await firstVisible(confirmationCandidates(this.page));
    if (confirm) await confirm.click();
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);
  }

  public async discoverPublishedContext(articleUrl: string): Promise<DiscoveredSiteState> {
    await this.navigate(articleUrl);
    const seriesLink = await firstVisible(seriesLinkCandidates(this.page, this.config.seriesTitle));
    if (seriesLink) {
      const href = await seriesLink.getAttribute('href');
      if (href) {
        const candidate = new URL(href, this.page.url()).toString();
        if (!/\/\d{4}ironman\/?$/u.test(new URL(candidate).pathname)) this.discovered.seriesUrl = candidate;
      }
    }
    return this.getDiscoveredState();
  }

  public getDiscoveredState(): DiscoveredSiteState {
    return { ...this.discovered };
  }

  public async captureDiagnostics(error: unknown): Promise<string> {
    const directory = await this.getDiagnosticDirectory();
    const results = await Promise.allSettled([
      this.page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }),
      this.page.content().then((html) => writeFile(join(directory, 'failure.html'), html, 'utf8')),
      writeFile(
        join(directory, 'failure.json'),
        `${JSON.stringify({ capturedAt: new Date().toISOString(), pageUrl: this.page.url(), ...errorDetails(error) }, null, 2)}\n`,
        'utf8',
      ),
    ]);
    const rejected = results.filter((result) => result.status === 'rejected');
    if (rejected.length > 0) this.logger.warn({ rejectedArtifacts: rejected.length }, 'Some diagnostic artifacts could not be captured');
    this.logger.error({ diagnosticDirectory: directory }, 'Failure diagnostics captured');
    return directory;
  }

  public async close(failed: boolean): Promise<void> {
    try {
      if (this.tracingStarted) {
        const retain = this.config.traceMode === 'always' || (this.config.traceMode === 'retain-on-failure' && failed);
        if (retain) {
          const directory = await this.getDiagnosticDirectory();
          await this.context.tracing.stop({ path: join(directory, 'trace.zip') });
          this.logger.info({ tracePath: join(directory, 'trace.zip') }, 'Playwright trace saved');
        } else {
          await this.context.tracing.stop();
        }
      }
    } finally {
      await this.browser.close();
    }
  }

  public static async protectAuthFile(path: string): Promise<void> {
    if (process.platform !== 'win32') await chmod(path, 0o600);
  }

  private async discoverAuthenticatedNavigation(): Promise<void> {
    const drafts = await this.firstHref(draftsLinkCandidates(this.page));
    const newArticle = await this.firstHref(newArticleLinkCandidates(this.page));
    if (drafts) this.discovered.draftsUrl = drafts;
    if (newArticle) this.discovered.newArticleUrl = newArticle;
  }

  private async requireAuthenticatedUrl(kind: 'drafts' | 'newArticle'): Promise<string> {
    const current = kind === 'drafts' ? this.discovered.draftsUrl : this.discovered.newArticleUrl;
    if (current) return current;
    await this.navigate(new URL('/', this.config.profileUrl).toString());
    await this.discoverAuthenticatedNavigation();
    const discovered = kind === 'drafts' ? this.discovered.draftsUrl : this.discovered.newArticleUrl;
    if (!discovered) {
      throw new AppError(
        `The authenticated ${kind === 'drafts' ? 'draft listing' : 'new article'} URL could not be discovered from semantic navigation.`,
        ExitCode.BrowserWorkflowFailed,
        { pageUrl: this.page.url() },
      );
    }
    return discovered;
  }

  private async discoverProfileArticlesUrl(): Promise<string> {
    await this.navigate(this.config.profileUrl);
    const expectedPrefix = `${new URL(this.config.profileUrl).pathname.replace(/\/$/u, '')}/articles`;
    const links = this.page.locator('a[href]');
    for (let index = 0; index < (await links.count()); index += 1) {
      const href = await links.nth(index).getAttribute('href');
      if (href && new URL(href, this.page.url()).pathname.startsWith(expectedPrefix)) {
        return new URL(href, this.page.url()).toString();
      }
    }
    throw new AppError('The public articles listing could not be discovered from the configured profile page', ExitCode.BrowserWorkflowFailed, {
      profileUrl: this.config.profileUrl,
    });
  }

  private async firstHref(candidates: Locator[]): Promise<string | undefined> {
    for (const candidate of candidates) {
      for (let index = 0; index < (await candidate.count()); index += 1) {
        const href = await candidate.nth(index).getAttribute('href');
        if (href) return new URL(href, this.page.url()).toString();
      }
    }
    return undefined;
  }

  private async navigate(url: string): Promise<void> {
    this.logger.debug({ url }, 'Navigating');
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  private async assertExpectedIdentity(pageKind: string, identifier: string): Promise<void> {
    const body = await this.page.locator('body').innerText();
    const urlContainsIdentifier = decodeURIComponent(this.page.url()).includes(identifier);
    if (!body.includes(identifier) && !urlContainsIdentifier) {
      throw new AppError(`Configured identifier is not visible on the ${pageKind}`, ExitCode.SafetyConflict, {
        identifier,
        pageUrl: this.page.url(),
      });
    }
  }

  private async firstNonEmptySelector(selectors: readonly string[]): Promise<Locator | undefined> {
    for (const selector of selectors) {
      const locator = this.page.locator(selector);
      if ((await locator.count()) > 0) return locator;
    }
    return undefined;
  }

  private async firstExisting(candidates: Locator[]): Promise<Locator | undefined> {
    for (const candidate of candidates) {
      if ((await candidate.count()) > 0) return candidate.first();
    }
    return undefined;
  }

  private async waitForExisting(candidates: Locator[]): Promise<Locator | undefined> {
    const deadline = Date.now() + this.config.actionTimeoutMs;
    while (Date.now() < deadline) {
      const locator = await this.firstExisting(candidates);
      if (locator) return locator;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  private async fillEditableValue(locator: Locator, value: string): Promise<void> {
    const codeMirrorFilled = await locator.evaluate((element, nextValue) => {
      const wrapper = element as HTMLElement & {
        CodeMirror?: { setValue: (markdown: string) => void; save?: () => void };
      };
      if (!wrapper.CodeMirror) return false;
      wrapper.CodeMirror.setValue(nextValue);
      wrapper.CodeMirror.save?.();
      return true;
    }, value);
    if (!codeMirrorFilled) await locator.fill(value);
  }

  private async setArticleTags(tags: string[]): Promise<void> {
    const select = this.page.locator('select[name="tags[]"]').first();
    if ((await select.count()) > 0) {
      await select.evaluate((element, requestedTags) => {
        if (!(element instanceof HTMLSelectElement)) return;
        for (const tag of requestedTags) {
          let option = [...element.options].find((candidate) => candidate.value === tag);
          if (!option) {
            option = new Option(tag, tag, true, true);
            element.add(option);
          }
          option.selected = true;
        }
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, tags);
      return;
    }

    const tagInput = await firstVisible(tagInputCandidates(this.page));
    if (!tagInput) {
      throw new AppError('The tag input could not be found', ExitCode.BrowserWorkflowFailed, { pageUrl: this.page.url() });
    }
    for (const tag of tags) {
      await tagInput.fill(tag);
      await tagInput.press('Enter');
    }
  }

  private async readSelectedTags(): Promise<string[] | undefined> {
    const select = this.page.locator('select[name="tags[]"]').first();
    if ((await select.count()) === 0) return undefined;
    return select.evaluate((element) =>
      element instanceof HTMLSelectElement ? [...element.selectedOptions].map((option) => option.value) : [],
    );
  }

  private async readEditableValue(locator: Locator): Promise<string> {
    return locator.evaluate((element) => {
      const editable = element as HTMLElement & {
        CodeMirror?: { getValue: () => string };
      };
      if (editable.CodeMirror) return editable.CodeMirror.getValue();
      if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) return editable.value;
      return editable.innerText;
    });
  }

  private async waitForUploadedUrl(editor: Locator, knownUrls: Set<string>): Promise<string> {
    const deadline = Date.now() + this.config.actionTimeoutMs;
    while (Date.now() < deadline) {
      const uploadedUrl = extractHttpUrls(await this.readEditableValue(editor)).find((url) => !knownUrls.has(url));
      if (uploadedUrl) return uploadedUrl;
      const insertImage = this.page.locator('#InsertImg');
      if (await insertImage.isVisible().catch(() => false)) {
        const remoteUrl = await this.page.locator('#uploadThumbnail').evaluate((element) =>
          element instanceof HTMLImageElement ? element.src : element.getAttribute('src'),
        );
        if (remoteUrl && /^https?:\/\//iu.test(remoteUrl)) {
          await insertImage.click();
          return remoteUrl;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new AppError('Image upload completed without a discoverable hosted URL in the editor', ExitCode.BrowserWorkflowFailed, {
      pageUrl: this.page.url(),
    });
  }

  private async readTitleAndUrl(card: Locator): Promise<{ title: string; url: string }> {
    for (const selector of selectorCatalog.titleLinks) {
      const candidates = card.locator(selector);
      for (let index = 0; index < (await candidates.count()); index += 1) {
        const candidate = candidates.nth(index);
        const title = (await candidate.innerText()).trim();
        const href = await candidate.getAttribute('href');
        if (title && href) return { title, url: new URL(href, this.page.url()).toString() };
      }
    }
    throw new AppError('An article/draft card has no recognizable semantic title link', ExitCode.BrowserWorkflowFailed, {
      pageUrl: this.page.url(),
    });
  }

  private async readPublicationDate(card: Locator, today: CalendarDate): Promise<CalendarDate | undefined> {
    for (const selector of selectorCatalog.dateElements) {
      const element = card.locator(selector).first();
      if ((await element.count()) === 0) continue;
      const datetime = await element.getAttribute('datetime');
      const text = await element.innerText().catch(() => '');
      const parsed = parsePublicationDate(`${datetime ?? ''} ${text}`, today);
      if (parsed) return parsed;
    }
    return parsePublicationDate(await card.innerText(), today);
  }

  private async getDiagnosticDirectory(): Promise<string> {
    if (!this.diagnosticDirectory) {
      const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
      this.diagnosticDirectory = join(this.config.diagnosticsDir, timestamp);
      await mkdir(this.diagnosticDirectory, { recursive: true });
    }
    return this.diagnosticDirectory;
  }
}

function extractHttpUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s)"'<>]+/giu)].map((match) => match[0]);
}

function normalizeMarkdown(value: string): string {
  return value.replaceAll('\r\n', '\n').trim();
}
