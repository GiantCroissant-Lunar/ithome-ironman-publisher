import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadArticleForDay } from '../src/content/article.js';
import type { GeneratedImageManifest } from '../src/content/generated-images.js';
import { loadArticleVisualPlan, validateSelectedVisualPlacement } from '../src/content/visual-plan.js';
import { AppError, ExitCode } from '../src/infra/errors.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createVisualPlanFixture(slots: string[], requestSlotOverrides: Record<string, string> = {}): Promise<string> {
  const articlesDirectory = await mkdtemp(join(tmpdir(), 'ironman-visual-plan-'));
  temporaryDirectories.push(articlesDirectory);
  const dayDirectory = join(articlesDirectory, 'day-001');
  const promptDirectory = join(dayDirectory, 'images', 'prompts');
  await mkdir(promptDirectory, { recursive: true });
  await writeFile(
    join(dayDirectory, 'index.md'),
    [
      '---',
      'title: Visual plan test',
      'timestamp: "2026-09-01T10:17:00+08:00"',
      'tags:',
      '  - Leonardo',
      '---',
      '',
      '# Visual plan test',
      '',
      '## First section',
      '',
      'Body.',
      '',
      '## Second section',
      '',
      'Body.',
      '',
      '## Third section',
      '',
      'Body.',
      '',
    ].join('\n'),
    'utf8',
  );
  const headings = ['## First section', '## Second section', '## Third section'];
  const assets = slots.map((slot, index) => ({
    slot,
    request: `./prompts/${slot}.json`,
    placement: slot === 'hero' ? { kind: 'article-start' } : { kind: 'after-heading', heading: headings[index - 1] },
  }));
  await writeFile(
    join(dayDirectory, 'images', 'visual-plan.json'),
    `${JSON.stringify({ version: 1, dayNumber: 1, assets }, undefined, 2)}\n`,
    'utf8',
  );
  for (const slot of slots) {
    await writeFile(
      join(promptDirectory, `${slot}.json`),
      `${JSON.stringify(
        {
          version: 1,
          dayNumber: 1,
          slot: requestSlotOverrides[slot] ?? slot,
          assetName: `${slot}-asset`,
          prompt: `A sufficiently detailed editorial illustration request for ${slot}`,
          aspectRatio: '16:9',
          style: 'Dynamic',
          model: 'Auto',
          maxCandidates: 1,
          alt: `${slot} illustration`,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );
  }
  return articlesDirectory;
}

describe('article visual plan', () => {
  it('requires one hero followed by two or three contiguous inline slots', async () => {
    const articlesDirectory = await createVisualPlanFixture(['hero', 'inline-01', 'inline-02', 'inline-03']);
    const article = await loadArticleForDay(articlesDirectory, 1);
    const plan = await loadArticleVisualPlan(article);
    expect(plan.assets.map((asset) => asset.slot)).toEqual(['hero', 'inline-01', 'inline-02', 'inline-03']);
  });

  it('rejects a plan with fewer than two inline visuals', async () => {
    const articlesDirectory = await createVisualPlanFixture(['hero', 'inline-01']);
    const article = await loadArticleForDay(articlesDirectory, 1);
    const error = await loadArticleVisualPlan(article).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.InvalidConfiguration);
  });

  it('rejects a missing inline sequence number', async () => {
    const articlesDirectory = await createVisualPlanFixture(['hero', 'inline-01', 'inline-03']);
    const article = await loadArticleForDay(articlesDirectory, 1);
    await expect(loadArticleVisualPlan(article)).rejects.toThrow('hero followed by two or three contiguous inline slots');
  });

  it('rejects a request whose declared slot differs from its visual plan entry', async () => {
    const articlesDirectory = await createVisualPlanFixture(['hero', 'inline-01', 'inline-02'], {
      'inline-02': 'inline-01',
    });
    const article = await loadArticleForDay(articlesDirectory, 1);
    await expect(loadArticleVisualPlan(article)).rejects.toThrow('Day and slot');
  });

  it('requires a selected hero to appear before the first level-two heading', async () => {
    const articlesDirectory = await createVisualPlanFixture(['hero', 'inline-01', 'inline-02']);
    const article = await loadArticleForDay(articlesDirectory, 1);
    const plan = await loadArticleVisualPlan(article);
    const misplaced = {
      ...article,
      markdown: `${article.markdown}\n![Hero](./images/generated/hero.jpg)\n`,
    };
    expect(() => validateSelectedVisualPlacement(misplaced, plan, manifestFor('hero', './images/generated/hero.jpg'))).toThrow(
      'before the first level-two heading',
    );
  });

  it('requires a selected inline image to stay inside its planned section', async () => {
    const articlesDirectory = await createVisualPlanFixture(['hero', 'inline-01', 'inline-02']);
    const article = await loadArticleForDay(articlesDirectory, 1);
    const plan = await loadArticleVisualPlan(article);
    const misplaced = {
      ...article,
      markdown: article.markdown.replace('## Third section', '![Inline](./images/generated/inline-01.jpg)\n\n## Third section'),
    };
    expect(() =>
      validateSelectedVisualPlacement(misplaced, plan, manifestFor('inline-01', './images/generated/inline-01.jpg')),
    ).toThrow('inside its planned article section');
  });
});

function manifestFor(slot: 'hero' | 'inline-01', path: string): GeneratedImageManifest {
  return {
    version: 1,
    provider: 'leonardo-ai',
    assets: [
      {
        path,
        sha256: 'a'.repeat(64),
        slot,
        model: 'Auto',
        prompt: 'A sufficiently detailed editorial illustration prompt',
        width: 1344,
        height: 768,
        generatedAt: '2026-09-01T12:00:00+08:00',
        alt: 'Illustration',
      },
    ],
  };
}
