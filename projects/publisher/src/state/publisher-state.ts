import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AppError, ExitCode } from '../infra/errors.js';

const assetStateSchema = z.object({
  sha256: z.string().regex(/^[a-f\d]{64}$/u),
  remoteUrl: z.url(),
});

const articleStateSchema = z.object({
  draftUrl: z.url().optional(),
  articleUrl: z.url().optional(),
  sourceHash: z.string().regex(/^[a-f\d]{64}$/u).optional(),
  renderedHash: z.string().regex(/^[a-f\d]{64}$/u).optional(),
  lastSyncedAt: z.iso.datetime().optional(),
  lastPublishedAt: z.iso.datetime().optional(),
  assets: z.record(z.string(), assetStateSchema).default({}),
});

const publisherStateSchema = z.object({
  version: z.literal(1),
  profileUrl: z.url(),
  seriesUrl: z.url().optional(),
  draftsUrl: z.url().optional(),
  newArticleUrl: z.url().optional(),
  articles: z.record(z.string(), articleStateSchema).default({}),
});

export type ArticleAssetState = z.infer<typeof assetStateSchema>;
export type ArticleRuntimeState = z.infer<typeof articleStateSchema>;
export type PublisherRuntimeState = z.infer<typeof publisherStateSchema>;

export interface DiscoveredSiteState {
  seriesUrl?: string;
  draftsUrl?: string;
  newArticleUrl?: string;
}

export class PublisherStateRepository {
  public constructor(
    private readonly path: string,
    private readonly profileUrl: string,
  ) {}

  public async load(): Promise<PublisherRuntimeState> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { version: 1, profileUrl: this.profileUrl, articles: {} };
      }
      throw new AppError('Publisher runtime state could not be read', ExitCode.InvalidConfiguration, { statePath: this.path });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new AppError('Publisher runtime state is not valid JSON', ExitCode.InvalidConfiguration, { statePath: this.path });
    }
    const parsed = publisherStateSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.profileUrl !== this.profileUrl) {
      throw new AppError('Publisher runtime state validation failed', ExitCode.InvalidConfiguration, {
        statePath: this.path,
        issues: parsed.success ? ['profileUrl does not match config'] : parsed.error.issues,
      });
    }
    return parsed.data;
  }

  public async save(state: PublisherRuntimeState): Promise<void> {
    const parsed = publisherStateSchema.safeParse(state);
    if (!parsed.success) {
      throw new AppError('Refusing to save invalid publisher runtime state', ExitCode.InvalidConfiguration, {
        issues: parsed.error.issues,
      });
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.path);
  }
}

export async function acquireProcessLock(path: string, staleAfterMs: number): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    await handle.close();
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw error;
    }
    const lockStat = await stat(path);
    if (Date.now() - lockStat.mtimeMs <= staleAfterMs) {
      throw new AppError('Another publisher process already holds the runtime lock', ExitCode.SafetyConflict, {
        lockPath: path,
        lockAgeMs: Date.now() - lockStat.mtimeMs,
      });
    }
    await unlink(path);
    return acquireProcessLock(path, staleAfterMs);
  }

  let released = false;
  return async () => {
    if (!released) {
      released = true;
      await unlink(path).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
