import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { LocalArticle } from './article.js';
import { AppError, ExitCode } from '../infra/errors.js';

const RFC3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SHA256 = /^[a-f\d]{64}$/u;
const GENERATED_PREFIX = './images/generated/';
const GENERATED_PATH = /^\.\/images\/generated\/(?:[a-z\d][a-z\d._-]*\/)*[a-z\d][a-z\d._-]*\.(?:png|jpe?g|gif|webp|avif)$/u;

const generatedAssetSchema = z
  .object({
    path: z.string().regex(GENERATED_PATH, 'path must be a canonical lowercase image path under ./images/generated/'),
    sha256: z.string().regex(SHA256),
    generationId: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    negativePrompt: z.string().trim().min(1).optional(),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    generatedAt: z
      .string()
      .refine(
        (value) => RFC3339_WITH_ZONE.test(value) && Number.isFinite(Date.parse(value)),
        'generatedAt must be RFC 3339 with an explicit offset',
      ),
    sourceUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash;
      }, 'sourceUrl must not contain credentials, query parameters, or a fragment')
      .optional(),
    alt: z.string().trim().min(1),
  })
  .strict();

const generatedImageManifestSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('leonardo-ai'),
    assets: z.array(generatedAssetSchema).min(1),
  })
  .strict();

export type GeneratedImageManifest = z.infer<typeof generatedImageManifestSchema>;

export function generatedImageManifestPath(article: LocalArticle): string {
  return resolve(article.directoryPath, 'images', 'generated', 'manifest.json');
}

export async function validateGeneratedImages(article: LocalArticle): Promise<GeneratedImageManifest | undefined> {
  const manifestPath = generatedImageManifestPath(article);
  const generatedReferences = article.images
    .map((image) => image.markdownReference)
    .filter((path) => path.startsWith(GENERATED_PREFIX));
  let source: string;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (generatedReferences.length > 0) {
        throw new AppError('Generated Markdown images require a provenance manifest', ExitCode.InvalidConfiguration, {
          manifestPath,
          generatedReferences,
        });
      }
      return undefined;
    }
    throw new AppError('Generated image manifest could not be read', ExitCode.InvalidConfiguration, { manifestPath });
  }

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new AppError('Generated image manifest is not valid JSON', ExitCode.InvalidConfiguration, { manifestPath });
  }
  const parsed = generatedImageManifestSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppError('Generated image manifest validation failed', ExitCode.InvalidConfiguration, {
      manifestPath,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }

  const imageByReference = new Map(article.images.map((image) => [image.markdownReference, image]));
  const manifestReferences = new Set<string>();
  const generatedDirectory = resolve(article.directoryPath, 'images', 'generated');
  for (const asset of parsed.data.assets) {
    if (manifestReferences.has(asset.path)) {
      throw new AppError('Generated image manifest contains a duplicate path', ExitCode.InvalidConfiguration, {
        manifestPath,
        path: asset.path,
      });
    }
    manifestReferences.add(asset.path);

    if (asset.path.includes('\\') || isAbsolute(asset.path) || win32.isAbsolute(asset.path)) {
      throw new AppError('Generated image manifest paths must use canonical relative forward-slash paths', ExitCode.InvalidConfiguration, {
        manifestPath,
        path: asset.path,
      });
    }
    const absolutePath = resolve(article.directoryPath, asset.path);
    const relativePath = relative(generatedDirectory, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new AppError('Generated image manifest path must stay inside images/generated', ExitCode.InvalidConfiguration, {
        manifestPath,
        path: asset.path,
      });
    }

    const articleImage = imageByReference.get(asset.path);
    if (!articleImage) {
      throw new AppError('Every selected generated image must be referenced by the article', ExitCode.InvalidConfiguration, {
        manifestPath,
        path: asset.path,
      });
    }
    if (articleImage.sha256 !== asset.sha256) {
      throw new AppError('Generated image SHA-256 does not match its manifest', ExitCode.InvalidConfiguration, {
        manifestPath,
        path: asset.path,
        expectedSha256: asset.sha256,
        actualSha256: articleImage.sha256,
      });
    }
  }

  const missingEntries = generatedReferences.filter((path) => !manifestReferences.has(path));
  if (missingEntries.length > 0) {
    throw new AppError('Every generated Markdown image must be declared in the provenance manifest', ExitCode.InvalidConfiguration, {
      manifestPath,
      missingEntries,
    });
  }
  return parsed.data;
}
