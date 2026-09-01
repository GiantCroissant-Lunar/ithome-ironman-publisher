import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AppError, ExitCode } from '../infra/errors.js';

const SAFE_ASSET_NAME = /^[a-z\d][a-z\d._-]*$/u;

const generationRequestSchema = z
  .object({
    version: z.literal(1),
    dayNumber: z.number().int().min(1).max(999),
    assetName: z.string().trim().regex(SAFE_ASSET_NAME, 'assetName must use lowercase letters, digits, dots, underscores, or hyphens'),
    prompt: z.string().trim().min(10).max(10_000),
    negativePrompt: z.string().trim().min(1).max(5_000).optional(),
    aspectRatio: z.string().trim().min(1).default('16:9'),
    style: z.string().trim().min(1).default('Dynamic'),
    model: z.string().trim().min(1).default('Auto'),
    maxCandidates: z.number().int().min(1).max(4).default(1),
    alt: z.string().trim().min(1).max(500),
  })
  .strict();

export type LeonardoGenerationRequest = z.infer<typeof generationRequestSchema>;

export async function loadGenerationRequest(path: string): Promise<LeonardoGenerationRequest> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    throw new AppError('Leonardo generation request could not be read', ExitCode.InvalidConfiguration, { requestPath: path });
  }

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new AppError('Leonardo generation request is not valid JSON', ExitCode.InvalidConfiguration, { requestPath: path });
  }

  const parsed = generationRequestSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppError('Leonardo generation request validation failed', ExitCode.InvalidConfiguration, {
      requestPath: path,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}
