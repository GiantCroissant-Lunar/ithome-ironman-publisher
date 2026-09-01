import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadArticleForDay } from '../src/content/article.js';
import { validateGeneratedImages } from '../src/content/generated-images.js';
import { AppError, ExitCode } from '../src/infra/errors.js';

const temporaryDirectories: string[] = [];
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createArticle(imagePath: string, manifestPath?: string): Promise<{ articlesDirectory: string; dayDirectory: string }> {
  const articlesDirectory = await mkdtemp(join(tmpdir(), 'ironman-generated-images-'));
  temporaryDirectories.push(articlesDirectory);
  const dayDirectory = join(articlesDirectory, 'day-001');
  await mkdir(join(dayDirectory, 'images', 'generated'), { recursive: true });
  const absoluteImagePath = join(dayDirectory, ...imagePath.replace(/^\.\//u, '').split('/'));
  await mkdir(join(absoluteImagePath, '..'), { recursive: true });
  await writeFile(absoluteImagePath, imageBytes);
  await writeFile(
    join(dayDirectory, 'index.md'),
    [
      '---',
      'title: Generated image test',
      'timestamp: "2026-09-01T10:17:00+08:00"',
      'tags:',
      '  - Leonardo',
      '---',
      '',
      '# Test',
      '',
      `![Generated visual](${imagePath})`,
      '',
    ].join('\n'),
    'utf8',
  );
  if (manifestPath) {
    await writeManifest(dayDirectory, manifestPath);
  }
  return { articlesDirectory, dayDirectory };
}

async function writeManifest(dayDirectory: string, path: string, sha256 = createHash('sha256').update(imageBytes).digest('hex')): Promise<void> {
  const manifest = {
    version: 1,
    provider: 'leonardo-ai',
    assets: [
      {
        path,
        sha256,
        generationId: 'generation-123',
        model: 'Lucid Origin',
        prompt: 'An editorial illustration of an AI agent coordinating a Unity workflow',
        width: 1536,
        height: 1024,
        generatedAt: '2026-09-01T12:00:00+08:00',
        sourceUrl: 'https://cdn.example.test/generated.png',
        alt: 'AI agent coordinating a Unity development workflow',
      },
    ],
  };
  await writeFile(join(dayDirectory, 'images', 'generated', 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
}

describe('generated image provenance', () => {
  it('accepts a referenced image whose SHA-256 matches the manifest', async () => {
    const imagePath = './images/generated/workflow.png';
    const { articlesDirectory } = await createArticle(imagePath, imagePath);
    const article = await loadArticleForDay(articlesDirectory, 1);
    const manifest = await validateGeneratedImages(article);
    expect(manifest).toMatchObject({ provider: 'leonardo-ai', assets: [{ path: imagePath }] });
  });

  it('rejects a generated Markdown image without a manifest', async () => {
    const { articlesDirectory } = await createArticle('./images/generated/workflow.png');
    const article = await loadArticleForDay(articlesDirectory, 1);
    const error = await validateGeneratedImages(article).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.InvalidConfiguration);
  });

  it('rejects a manifest hash that does not match the selected file', async () => {
    const imagePath = './images/generated/workflow.png';
    const { articlesDirectory, dayDirectory } = await createArticle(imagePath);
    await writeManifest(dayDirectory, imagePath, '0'.repeat(64));
    const article = await loadArticleForDay(articlesDirectory, 1);
    const error = await validateGeneratedImages(article).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('SHA-256');
  });

  it('rejects a manifest path that escapes images/generated', async () => {
    const imagePath = './images/generated/../../escaped.png';
    const { articlesDirectory } = await createArticle(imagePath, imagePath);
    const article = await loadArticleForDay(articlesDirectory, 1);
    const error = await validateGeneratedImages(article).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toBe('Generated image manifest validation failed');
  });

  it('rejects a selected manifest asset that is not referenced by the article', async () => {
    const imagePath = './images/generated/workflow.png';
    const { articlesDirectory, dayDirectory } = await createArticle('./ordinary.png');
    await writeFile(join(dayDirectory, 'images', 'generated', 'workflow.png'), imageBytes);
    await writeManifest(dayDirectory, imagePath);
    const article = await loadArticleForDay(articlesDirectory, 1);
    const error = await validateGeneratedImages(article).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('referenced by the article');
  });
});
