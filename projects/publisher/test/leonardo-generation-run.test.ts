import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateGenerationRunArtifacts } from '../src/leonardo/generation-run.js';
import { AppError, ExitCode } from '../src/infra/errors.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRun(): Promise<{ runPath: string; candidatePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'leonardo-run-'));
  temporaryDirectories.push(directory);
  const candidatePath = join(directory, 'candidate-01.jpg');
  const bytes = Buffer.from('candidate-image');
  await writeFile(candidatePath, bytes);
  const runPath = join(directory, 'run.json');
  await writeFile(
    runPath,
    `${JSON.stringify(
      {
        version: 1,
        runId: '2026-09-01T12-00-00-000Z-example',
        generatedAt: '2026-09-01T12:00:00.000Z',
        pageUrl: 'https://app.leonardo.ai/generation/image/example-00000000-0000-0000-0000-000000000001',
        request: {
          version: 1,
          dayNumber: 1,
          slot: 'hero',
          assetName: 'hero',
          prompt: 'A sufficiently detailed editorial hero illustration',
          aspectRatio: '16:9',
          style: 'Dynamic',
          model: 'Auto',
          maxCandidates: 1,
          alt: 'Hero illustration',
        },
        candidates: [
          {
            index: 1,
            fileName: 'candidate-01.jpg',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            width: 1344,
            height: 768,
          },
        ],
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );
  return { runPath, candidatePath };
}

describe('Leonardo generation run artifacts', () => {
  it('re-reads and verifies a downloaded candidate SHA-256', async () => {
    const { runPath } = await createRun();
    await expect(validateGenerationRunArtifacts(runPath)).resolves.toMatchObject({ candidates: [{ width: 1344, height: 768 }] });
  });

  it('detects candidate bytes changed after the run record was written', async () => {
    const { runPath, candidatePath } = await createRun();
    await writeFile(candidatePath, 'tampered');
    const error = await validateGenerationRunArtifacts(runPath).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.VerificationFailed);
  });
});
