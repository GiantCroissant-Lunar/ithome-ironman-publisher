import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/schema.js';
import { AppError, ExitCode } from '../src/infra/errors.js';
import { assertGitReadyForPublication, syncPublicationReceiptToGit } from '../src/publication/git-publication.js';
import {
  canonicalIthomeArticleUrl,
  extractIthomeArticleId,
  readPublicationReceipt,
  writePublicationReceipt,
  type PublicationReceipt,
} from '../src/publication/publication-receipt.js';
import { recordAndSyncPublication } from '../src/publication/sync-publication.js';
import type { PublisherRuntimeState } from '../src/state/publisher-state.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function receipt(articleId = '10406763'): PublicationReceipt {
  return {
    version: 1,
    dayNumber: 1,
    articleId,
    articleUrl: `https://ithelp.ithome.com.tw/articles/${articleId}`,
    seriesUrl: 'https://ithelp.ithome.com.tw/users/20107519/ironman/9242',
    ironmanYear: 2026,
    seriesTitle: 'From (Unity) Game Dev to Orchestration of (Unity) Game Dev',
    category: 'Vibe Coding',
    title: 'Day 001',
    publishedAt: '2026-09-01T10:17:00.000Z',
    sourceHash: 'a'.repeat(64),
    renderedHash: 'b'.repeat(64),
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execFileAsync('git', arguments_, { cwd, encoding: 'utf8' });
  return result.stdout;
}

async function createGitRepository(): Promise<{ repository: string; remote: string }> {
  const root = await temporaryDirectory('ironman-git-');
  const repository = join(root, 'repository');
  const remote = join(root, 'remote.git');
  await mkdir(repository);
  await git(root, 'init', '--bare', remote);
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Publisher Test');
  await git(repository, 'config', 'user.email', 'publisher@example.test');
  await writeFile(join(repository, 'README.md'), '# Test\n', 'utf8');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', 'chore: initialize');
  await git(repository, 'branch', '-M', 'main');
  await git(repository, 'remote', 'add', 'origin', remote);
  await git(repository, 'push', '-u', 'origin', 'main');
  return { repository, remote };
}

describe('publication receipt', () => {
  it('extracts an iT article ID only from the configured origin and canonical article path', () => {
    const profileUrl = 'https://ithelp.ithome.com.tw/users/20107519';
    expect(extractIthomeArticleId('https://ithelp.ithome.com.tw/articles/10406763', profileUrl)).toBe('10406763');
    expect(canonicalIthomeArticleUrl('https://ithelp.ithome.com.tw/articles/10406763/?from=profile#top', profileUrl)).toBe(
      'https://ithelp.ithome.com.tw/articles/10406763',
    );
    expect(() => extractIthomeArticleId('https://example.test/articles/10406763', profileUrl)).toThrow(AppError);
    expect(() => extractIthomeArticleId('https://ithelp.ithome.com.tw/articles/create', profileUrl)).toThrow(AppError);
  });

  it('writes an immutable receipt and rejects a conflicting article ID', async () => {
    const articlesDirectory = await temporaryDirectory('ironman-receipt-');
    const first = await writePublicationReceipt(articlesDirectory, receipt());
    expect(first.changed).toBe(true);
    await expect(readPublicationReceipt(first.path)).resolves.toEqual(receipt());
    await expect(writePublicationReceipt(articlesDirectory, receipt())).resolves.toMatchObject({ changed: false });
    const error = await writePublicationReceipt(articlesDirectory, receipt('10406764')).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.SafetyConflict);
  });

  it('commits and pushes only the tracked receipt, then remains idempotent', async () => {
    const { repository, remote } = await createGitRepository();
    await assertGitReadyForPublication(repository);
    const articlesDirectory = join(repository, 'articles');
    const written = await writePublicationReceipt(articlesDirectory, receipt());
    const first = await syncPublicationReceiptToGit(repository, written.path, 1, written.receipt.articleId);
    expect(first).toMatchObject({ committed: true, pushed: true, receiptPath: 'articles/day-001/publication.json' });
    expect(await git(repository, 'status', '--porcelain')).toBe('');
    expect(await git(remote, 'log', '--format=%s', '-1', 'main')).toContain('record Day 001 publication 10406763');

    const second = await syncPublicationReceiptToGit(repository, written.path, 1, written.receipt.articleId);
    expect(second).toMatchObject({ committed: false, pushed: true });
  });

  it('refuses a live publication when the Git working tree is dirty', async () => {
    const { repository } = await createGitRepository();
    await writeFile(join(repository, 'unrelated.txt'), 'dirty\n', 'utf8');
    const error = await assertGitReadyForPublication(repository).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.SafetyConflict);
  });

  it('refuses a live publication when the local branch is ahead of upstream', async () => {
    const { repository } = await createGitRepository();
    await writeFile(join(repository, 'ahead.txt'), 'ahead\n', 'utf8');
    await git(repository, 'add', 'ahead.txt');
    await git(repository, 'commit', '-m', 'test: local ahead commit');
    const error = await assertGitReadyForPublication(repository).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.SafetyConflict);
    expect((error as AppError).details).toMatchObject({ ahead: 1, behind: 0 });
  });

  it('recovers a verified article URL into a receipt commit without a browser workflow', async () => {
    const { repository, remote } = await createGitRepository();
    const articleDirectory = join(repository, 'articles', 'day-001');
    await mkdir(articleDirectory, { recursive: true });
    await writeFile(
      join(articleDirectory, 'index.md'),
      [
        '---',
        'title: Day 001：Test publication receipt',
        'timestamp: "2026-09-01T10:17:00+08:00"',
        'tags:',
        '  - Test',
        '---',
        '',
        '# Test publication receipt',
        '',
      ].join('\n'),
      'utf8',
    );
    await git(repository, 'add', 'articles/day-001/index.md');
    await git(repository, 'commit', '-m', 'test: add article source');
    await git(repository, 'push');

    const profileUrl = 'https://ithelp.ithome.com.tw/users/20107519';
    const config = loadConfig(
      {
        ITHOME_PROFILE_URL: profileUrl,
        ITHOME_USER_IDENTIFIER: 'ApprenticeGC',
        IRONMAN_SERIES_TITLE: 'From (Unity) Game Dev to Orchestration of (Unity) Game Dev',
        IRONMAN_CATEGORY: 'Vibe Coding',
        IRONMAN_START_DATE: '2026-09-01',
        ARTICLES_DIR: 'articles',
        REPOSITORY_ROOT: '.',
      },
      repository,
    );
    const state: PublisherRuntimeState = {
      version: 1,
      profileUrl,
      seriesUrl: 'https://ithelp.ithome.com.tw/users/20107519/ironman/9242',
      articles: {
        'day-001': {
          renderedHash: 'b'.repeat(64),
          lastPublishedAt: '2026-09-01T02:17:00.000Z',
          assets: {},
        },
      },
    };

    const result = await recordAndSyncPublication(
      config,
      state,
      1,
      'https://ithelp.ithome.com.tw/articles/10406763/?from=profile',
    );
    expect(result.receipt).toMatchObject({
      articleId: '10406763',
      articleUrl: 'https://ithelp.ithome.com.tw/articles/10406763',
      publishedAt: '2026-09-01T02:17:00.000Z',
      renderedHash: 'b'.repeat(64),
    });
    expect(result.receipt.sourceHash).toMatch(/^[a-f\d]{64}$/u);
    expect(result.git).toMatchObject({ committed: true, pushed: true });
    expect(await git(remote, 'show', 'main:articles/day-001/publication.json')).toContain('"articleId": "10406763"');
  });
});
