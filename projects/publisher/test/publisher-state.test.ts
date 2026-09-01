import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ExitCode } from '../src/infra/errors.js';
import {
  acquireProcessLock,
  PublisherStateRepository,
  type PublisherRuntimeState,
} from '../src/state/publisher-state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ironman-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('publisher runtime state', () => {
  it('starts empty, then atomically round-trips discovered URLs and article hashes', async () => {
    const directory = await createTemporaryDirectory();
    const profileUrl = 'https://example.test/users/20107519';
    const repository = new PublisherStateRepository(join(directory, 'state', 'publisher-state.json'), profileUrl);

    await expect(repository.load()).resolves.toEqual({ version: 1, profileUrl, articles: {} });

    const state: PublisherRuntimeState = {
      version: 1,
      profileUrl,
      seriesUrl: 'https://example.test/users/20107519/ironman/123',
      draftsUrl: 'https://example.test/drafts',
      newArticleUrl: 'https://example.test/articles/new',
      articles: {
        'day-001': {
          draftUrl: 'https://example.test/drafts/1',
          articleUrl: 'https://example.test/articles/1',
          sourceHash: 'a'.repeat(64),
          renderedHash: 'b'.repeat(64),
          assets: {
            './ref-image-001.png': {
              sha256: 'c'.repeat(64),
              remoteUrl: 'https://example.test/uploads/ref-image-001.png',
            },
          },
        },
      },
    };
    await repository.save(state);
    await expect(repository.load()).resolves.toEqual(state);
  });

  it('prevents overlapping publisher processes and allows a new run after release', async () => {
    const directory = await createTemporaryDirectory();
    const lockPath = join(directory, 'state', 'publisher.lock');
    const release = await acquireProcessLock(lockPath, 60_000);

    const error = await acquireProcessLock(lockPath, 60_000).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.SafetyConflict);

    await release();
    const releaseAgain = await acquireProcessLock(lockPath, 60_000);
    await releaseAgain();
  });
});
