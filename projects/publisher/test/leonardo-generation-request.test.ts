import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ExitCode } from '../src/infra/errors.js';
import { loadGenerationRequest } from '../src/leonardo/generation-request.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeRequest(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'leonardo-request-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'request.json');
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

describe('Leonardo generation request', () => {
  it('applies safe defaults to a valid tracked request', async () => {
    const path = await writeRequest({
      version: 1,
      dayNumber: 2,
      assetName: 'workflow-hero',
      prompt: 'A detailed editorial illustration of an agent workflow',
      alt: 'Agent workflow illustration',
    });

    await expect(loadGenerationRequest(path)).resolves.toMatchObject({
      aspectRatio: '16:9',
      style: 'Dynamic',
      model: 'Auto',
      maxCandidates: 1,
    });
  });

  it('rejects names that could escape or create non-canonical article paths', async () => {
    const path = await writeRequest({
      version: 1,
      dayNumber: 1,
      assetName: '../Hero',
      prompt: 'A detailed editorial illustration of an agent workflow',
      alt: 'Agent workflow illustration',
    });
    const error = await loadGenerationRequest(path).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.InvalidConfiguration);
  });

  it('rejects unrecognized fields instead of silently changing token-consuming behavior', async () => {
    const path = await writeRequest({
      version: 1,
      dayNumber: 1,
      assetName: 'hero',
      prompt: 'A detailed editorial illustration of an agent workflow',
      alt: 'Agent workflow illustration',
      generations: 100,
    });
    await expect(loadGenerationRequest(path)).rejects.toThrow('validation failed');
  });
});
