import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { AppError, ExitCode } from '../infra/errors.js';
import type { LeonardoGenerationRequest } from './generation-request.js';

const SHA256 = /^[a-f\d]{64}$/u;

const candidateSchema = z
  .object({
    index: z.number().int().positive(),
    fileName: z.string().trim().min(1),
    sha256: z.string().regex(SHA256),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    generationId: z.string().trim().min(1).optional(),
    sourceUrl: z.url().optional(),
  })
  .strict();

const runSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().trim().min(1),
    generatedAt: z.iso.datetime({ offset: true }),
    pageUrl: z.url(),
    request: z
      .object({
        version: z.literal(1),
        dayNumber: z.number().int().min(1).max(999),
        slot: z.enum(['hero', 'inline-01', 'inline-02', 'inline-03']).optional(),
        assetName: z.string().trim().min(1),
        prompt: z.string().trim().min(1),
        negativePrompt: z.string().trim().min(1).optional(),
        aspectRatio: z.string().trim().min(1),
        style: z.string().trim().min(1),
        model: z.string().trim().min(1),
        maxCandidates: z.number().int().min(1).max(4),
        alt: z.string().trim().min(1),
      })
      .strict(),
    candidates: z.array(candidateSchema).min(1),
  })
  .strict();

export type LeonardoGenerationRun = z.infer<typeof runSchema>;
export type LeonardoGenerationCandidate = z.infer<typeof candidateSchema>;

export interface DownloadedCandidate {
  fileName: string;
  width: number;
  height: number;
  generationId?: string;
  sourceUrl?: string;
}

export async function recordCandidate(
  directory: string,
  index: number,
  candidate: DownloadedCandidate,
): Promise<LeonardoGenerationCandidate> {
  const filePath = resolve(directory, candidate.fileName);
  const bytes = await readFile(filePath);
  return {
    index,
    fileName: candidate.fileName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: candidate.width,
    height: candidate.height,
    ...(candidate.generationId ? { generationId: candidate.generationId } : {}),
    ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
  };
}

export async function loadGenerationRun(path: string): Promise<LeonardoGenerationRun> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    throw new AppError('Leonardo generation run could not be read', ExitCode.InvalidConfiguration, { runPath: path });
  }
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new AppError('Leonardo generation run is not valid JSON', ExitCode.InvalidConfiguration, { runPath: path });
  }
  const parsed = runSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppError('Leonardo generation run validation failed', ExitCode.InvalidConfiguration, {
      runPath: path,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

export async function validateGenerationRunArtifacts(path: string): Promise<LeonardoGenerationRun> {
  const run = await loadGenerationRun(path);
  const directory = dirname(path);
  for (const candidate of run.candidates) {
    const candidatePath = resolve(directory, candidate.fileName);
    const relativePath = relative(directory, candidatePath);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new AppError('Leonardo run candidate path escapes its run directory', ExitCode.InvalidConfiguration, {
        runPath: path,
        candidateFileName: candidate.fileName,
      });
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(candidatePath);
    } catch {
      throw new AppError('Leonardo run candidate could not be read', ExitCode.VerificationFailed, {
        runPath: path,
        candidatePath,
      });
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== candidate.sha256) {
      throw new AppError('Leonardo run candidate SHA-256 does not match its record', ExitCode.VerificationFailed, {
        runPath: path,
        candidatePath,
        expectedSha256: candidate.sha256,
        actualSha256: sha256,
      });
    }
  }
  return run;
}

export function normalizedDownloadedExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.avif'].includes(extension) ? extension : '.png';
}

export function createRunRecord(
  runId: string,
  generatedAt: string,
  pageUrl: string,
  request: LeonardoGenerationRequest,
  candidates: LeonardoGenerationCandidate[],
): LeonardoGenerationRun {
  return runSchema.parse({ version: 1, runId, generatedAt, pageUrl, request, candidates });
}
