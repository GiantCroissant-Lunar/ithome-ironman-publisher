import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadProjectEnvironment } from '../config/environment.js';
import { loadArticleForDay } from '../content/article.js';
import { validateGeneratedImages, type GeneratedImageManifest } from '../content/generated-images.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { loadLeonardoConfig } from '../leonardo/config.js';
import { loadGenerationRun, normalizedDownloadedExtension } from '../leonardo/generation-run.js';

loadProjectEnvironment();

const SAFE_FILE_NAME = /^[a-z\d][a-z\d._-]*\.(?:png|jpe?g|webp|avif)$/u;

interface PromoteArguments {
  runPath: string;
  candidateIndex: number;
  outputName?: string;
}

function parseArguments(arguments_: string[]): PromoteArguments {
  const valueFor = (name: string): string | undefined => {
    const index = arguments_.indexOf(name);
    return index >= 0 ? arguments_[index + 1] : undefined;
  };
  const rawRun = arguments_[0]?.startsWith('--') === false ? arguments_[0] : undefined;
  const rawCandidate = valueFor('--candidate') ?? '1';
  const outputName = valueFor('--name');
  const recognized = new Set(['--candidate', '--name']);
  const consumed = new Set<number>();
  if (rawRun) consumed.add(0);
  for (const [index, value] of arguments_.entries()) {
    if (recognized.has(value)) {
      consumed.add(index);
      consumed.add(index + 1);
    }
  }
  const unknown = arguments_.filter((_value, index) => !consumed.has(index));
  const candidateIndex = Number(rawCandidate);
  if (!rawRun || !Number.isInteger(candidateIndex) || candidateIndex < 1 || candidateIndex > 4 || unknown.length > 0) {
    throw new AppError(
      'Usage: npm run leonardo:promote -- <run.json> [--candidate N] [--name hero.png]',
      ExitCode.InvalidConfiguration,
      { unknown },
    );
  }
  return {
    runPath: resolve(process.cwd(), rawRun),
    candidateIndex,
    ...(outputName ? { outputName } : {}),
  };
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const config = loadLeonardoConfig();
  const logger = createLogger(config.logLevel);
  assertInside(config.outputDirectory, cli.runPath, 'Generation run must stay inside the ignored Leonardo output directory');
  const run = await loadGenerationRun(cli.runPath);
  const candidate = run.candidates.find((item) => item.index === cli.candidateIndex);
  if (!candidate) {
    throw new AppError('Selected Leonardo candidate does not exist in this run', ExitCode.InvalidConfiguration, {
      candidateIndex: cli.candidateIndex,
      available: run.candidates.map((item) => item.index),
    });
  }

  const runDirectory = dirname(cli.runPath);
  const sourcePath = resolve(runDirectory, candidate.fileName);
  assertInside(runDirectory, sourcePath, 'Candidate file must stay inside its generation run');
  const sourceBytes = await readFile(sourcePath);
  const actualHash = createHash('sha256').update(sourceBytes).digest('hex');
  if (actualHash !== candidate.sha256) {
    throw new AppError('Leonardo candidate SHA-256 no longer matches its run record', ExitCode.VerificationFailed, {
      sourcePath,
      expectedSha256: candidate.sha256,
      actualSha256: actualHash,
    });
  }

  const extension = normalizedDownloadedExtension(candidate.fileName);
  const outputName = cli.outputName ?? `${run.request.assetName}${extension}`;
  if (!SAFE_FILE_NAME.test(outputName)) {
    throw new AppError('Promoted image name must be a canonical lowercase supported filename', ExitCode.InvalidConfiguration, {
      outputName,
    });
  }
  if (extname(outputName) !== extension) {
    throw new AppError('Promoted image extension must match the downloaded candidate', ExitCode.InvalidConfiguration, {
      outputName,
      candidateFileName: candidate.fileName,
    });
  }

  const articlesDirectory = resolve(process.cwd(), process.env.ARTICLES_DIR ?? '../../articles');
  const dayDirectory = resolve(articlesDirectory, `day-${String(run.request.dayNumber).padStart(3, '0')}`);
  const markdownReference = `./images/generated/${outputName}`;
  const articleSource = await readFile(join(dayDirectory, 'index.md'), 'utf8');
  if (!articleSource.includes(`](${markdownReference})`)) {
    throw new AppError('Reference the selected generated image in index.md before promotion', ExitCode.InvalidConfiguration, {
      articlePath: join(dayDirectory, 'index.md'),
      markdownReference,
      suggestedMarkdown: `![${run.request.alt}](${markdownReference})`,
    });
  }

  const destinationDirectory = join(dayDirectory, 'images', 'generated');
  const destinationPath = join(destinationDirectory, outputName);
  await mkdir(destinationDirectory, { recursive: true });
  await copyIdempotently(sourcePath, destinationPath, candidate.sha256);

  const manifestPath = join(destinationDirectory, 'manifest.json');
  const manifest = await readManifest(manifestPath);
  const sourceUrl = candidate.sourceUrl ? safeStableUrl(candidate.sourceUrl) : undefined;
  const asset = {
    path: markdownReference,
    sha256: candidate.sha256,
    ...(run.request.slot ? { slot: run.request.slot } : {}),
    ...(candidate.generationId ? { generationId: candidate.generationId } : {}),
    model: run.request.model,
    prompt: run.request.prompt,
    ...(run.request.negativePrompt ? { negativePrompt: run.request.negativePrompt } : {}),
    width: candidate.width,
    height: candidate.height,
    generatedAt: run.generatedAt,
    ...(sourceUrl ? { sourceUrl } : {}),
    alt: run.request.alt,
  };
  const existing = manifest.assets.find((item) => item.path === markdownReference);
  if (existing && existing.sha256 !== candidate.sha256) {
    throw new AppError('A different generated image already owns this manifest path', ExitCode.SafetyConflict, {
      manifestPath,
      markdownReference,
    });
  }
  const next: GeneratedImageManifest = {
    version: 1,
    provider: 'leonardo-ai',
    assets: [...manifest.assets.filter((item) => item.path !== markdownReference), asset],
  };
  await writeJsonAtomically(manifestPath, next);
  const article = await loadArticleForDay(articlesDirectory, run.request.dayNumber);
  await validateGeneratedImages(article);
  logger.info(
    { dayNumber: run.request.dayNumber, destinationPath, manifestPath, sha256: candidate.sha256 },
    'Leonardo candidate promoted and provenance verified',
  );
}

async function readManifest(path: string): Promise<GeneratedImageManifest> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as GeneratedImageManifest;
    if (data.version !== 1 || data.provider !== 'leonardo-ai' || !Array.isArray(data.assets)) throw new Error('invalid');
    return data;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, provider: 'leonardo-ai', assets: [] };
    throw new AppError('Existing generated image manifest could not be safely extended', ExitCode.InvalidConfiguration, {
      manifestPath: path,
    });
  }
}

async function copyIdempotently(source: string, destination: string, sha256: string): Promise<void> {
  try {
    const existing = await readFile(destination);
    const existingHash = createHash('sha256').update(existing).digest('hex');
    if (existingHash !== sha256) {
      throw new AppError('Promotion refuses to overwrite a different tracked image', ExitCode.SafetyConflict, { destination });
    }
    return;
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function assertInside(parent: string, child: string, message: string): void {
  const relativePath = relative(resolve(parent), resolve(child));
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new AppError(message, ExitCode.InvalidConfiguration, { parent, child });
  }
}

function safeStableUrl(value: string): string | undefined {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href : undefined;
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
