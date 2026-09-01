import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LocalArticle } from '../src/content/article.js';
import type {
  DraftArticle,
  DraftSyncResult,
  PublisherSite,
  PublicArticleSnapshot,
} from '../src/site/publisher-site.js';
import { runPublishWorkflow } from '../src/workflow/publish-workflow.js';
import { AppError, ExitCode } from '../src/infra/errors.js';

const emptySnapshot: PublicArticleSnapshot = {
  listingRecognized: true,
  dateEvidenceComplete: true,
  articles: [],
};

const localArticle: LocalArticle = {
  dayNumber: 1,
  directoryPath: 'C:\\articles\\day-001',
  sourcePath: 'C:\\articles\\day-001\\index.md',
  title: 'Day 001：先讓 Agent 自己發文——ADE 的第一個自動化應用',
  timestamp: '2026-09-01T10:17:00+08:00',
  scheduledAt: new Date('2026-09-01T02:17:00.000Z'),
  tags: ['Playwright', 'TypeScript'],
  markdown: '# Test\n\n![image](./ref-image-001.png)',
  images: [
    {
      markdownReference: './ref-image-001.png',
      absolutePath: 'C:\\articles\\day-001\\ref-image-001.png',
      mimeType: 'image/png',
      sha256: 'b'.repeat(64),
    },
  ],
  sourceHash: 'a'.repeat(64),
};

function createSite(overrides: Partial<PublisherSite> = {}): PublisherSite {
  return {
    assertAuthenticated: vi.fn(async () => undefined),
    getPublicArticleSnapshot: vi.fn(async () => emptySnapshot),
    listDrafts: vi.fn(async () => [
      { title: localArticle.title, url: 'https://example.test/draft/1' },
    ]),
    syncDraft: vi.fn(
      async (_article: LocalArticle, existingDraft: DraftArticle | undefined): Promise<DraftSyncResult> => ({
        action: existingDraft ? 'updated' : 'created',
        uploadedImages: 1,
        sourceHash: localArticle.sourceHash,
        renderedHash: 'c'.repeat(64),
        assets: {
          './ref-image-001.png': {
            sha256: localArticle.images[0]?.sha256 ?? '',
            remoteUrl: 'https://example.test/uploaded/ref-image-001.png',
          },
        },
        draft: existingDraft ?? { title: localArticle.title, url: 'https://example.test/draft/new' },
      }),
    ),
    publishDraft: vi.fn(async () => undefined),
    discoverPublishedContext: vi.fn(async () => ({})),
    getDiscoveredState: vi.fn(() => ({})),
    ...overrides,
  };
}

const baseOptions = {
  timeZone: 'Asia/Taipei',
  startDate: '2026-09-01',
  maximumDay: 30,
  articlesDir: 'C:\\articles',
  dryRun: true,
  publishedUpdatePolicy: 'report' as const,
  verificationAttempts: 2,
  verificationDelayMs: 0,
};

const dependencies = (site: PublisherSite, now = new Date('2026-09-01T02:17:00.000Z')) => ({
  site,
  logger: pino({ level: 'silent' }),
  now: () => now,
  sleep: vi.fn(async () => undefined),
  loadArticle: vi.fn(async () => localArticle),
});

describe('publish workflow with local content and a mocked browser boundary', () => {
  it('validates local content and reports an existing draft update in dry-run mode', async () => {
    const site = createSite();
    const result = await runPublishWorkflow(baseOptions, dependencies(site));

    expect(result).toEqual({
      status: 'dry-run',
      dayNumber: 1,
      expectedTitle: localArticle.title,
      draftAction: 'would-update',
      draftUrl: 'https://example.test/draft/1',
    });
    expect(site.syncDraft).not.toHaveBeenCalled();
    expect(site.publishDraft).not.toHaveBeenCalled();
  });

  it('reports that a missing draft would be created without mutating the site', async () => {
    const site = createSite({ listDrafts: vi.fn(async () => []) });
    const result = await runPublishWorkflow(baseOptions, dependencies(site));
    expect(result).toEqual({
      status: 'dry-run',
      dayNumber: 1,
      expectedTitle: localArticle.title,
      draftAction: 'would-create',
    });
    expect(site.syncDraft).not.toHaveBeenCalled();
  });

  it('returns before draft synchronization when today is already published', async () => {
    const site = createSite({
      getPublicArticleSnapshot: vi.fn(async () => ({
        listingRecognized: true,
        dateEvidenceComplete: true,
        articles: [
          {
            title: localArticle.title,
            url: 'https://example.test/article/1',
            publishedDate: { year: 2026, month: 9, day: 1 },
          },
        ],
      })),
    });

    const result = await runPublishWorkflow(baseOptions, dependencies(site));
    expect(result.status).toBe('already-published');
    expect(site.listDrafts).not.toHaveBeenCalled();
    expect(site.syncDraft).not.toHaveBeenCalled();
    expect(site.publishDraft).not.toHaveBeenCalled();
  });

  it('creates a missing draft, uploads content, publishes once, and verifies publicly', async () => {
    const getSnapshot = vi
      .fn<PublisherSite['getPublicArticleSnapshot']>()
      .mockResolvedValueOnce(emptySnapshot)
      .mockResolvedValueOnce({
        listingRecognized: true,
        dateEvidenceComplete: true,
        articles: [
          {
            title: localArticle.title,
            url: 'https://example.test/article/1',
            publishedDate: { year: 2026, month: 9, day: 1 },
          },
        ],
      });
    const site = createSite({ getPublicArticleSnapshot: getSnapshot, listDrafts: vi.fn(async () => []) });

    const result = await runPublishWorkflow({ ...baseOptions, dryRun: false }, dependencies(site));
    expect(result).toEqual({
      status: 'published',
      dayNumber: 1,
      expectedTitle: localArticle.title,
      articleUrl: 'https://example.test/article/1',
      draftAction: 'created',
    });
    expect(site.syncDraft).toHaveBeenCalledWith(localArticle, undefined, undefined);
    expect(site.publishDraft).toHaveBeenCalledOnce();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('refuses duplicate exact-title drafts', async () => {
    const site = createSite({
      listDrafts: vi.fn(async () => [
        { title: localArticle.title, url: 'https://example.test/draft/1' },
        { title: localArticle.title, url: 'https://example.test/draft/2' },
      ]),
    });
    const error = await runPublishWorkflow(baseOptions, dependencies(site)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.DraftSelectionFailed);
    expect(site.syncDraft).not.toHaveBeenCalled();
  });

  it('does not run before the article timestamp', async () => {
    const site = createSite();
    const error = await runPublishWorkflow(
      baseOptions,
      dependencies(site, new Date('2026-09-01T02:16:59.000Z')),
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.DayOutOfRange);
    expect(site.assertAuthenticated).not.toHaveBeenCalled();
  });

  it('returns a verification exit code when publishing cannot be confirmed', async () => {
    const site = createSite();
    const error = await runPublishWorkflow({ ...baseOptions, dryRun: false }, dependencies(site)).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.VerificationFailed);
    expect(site.publishDraft).toHaveBeenCalledOnce();
  });
});
