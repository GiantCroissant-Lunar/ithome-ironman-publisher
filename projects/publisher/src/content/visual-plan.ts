import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { LocalArticle } from './article.js';
import type { GeneratedImageManifest } from './generated-images.js';
import { AppError, ExitCode } from '../infra/errors.js';
import {
  leonardoImageSlots,
  loadGenerationRequest,
  type LeonardoGenerationRequest,
} from '../leonardo/generation-request.js';

const slotSchema = z.enum(leonardoImageSlots);
const requestPathSchema = z.string().regex(/^\.\/prompts\/(?:hero|inline-0[1-3])\.json$/u);
const placementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('article-start') }).strict(),
  z.object({ kind: z.literal('after-heading'), heading: z.string().trim().regex(/^##\s+\S/u) }).strict(),
]);
const planSchema = z
  .object({
    version: z.literal(1),
    dayNumber: z.number().int().min(1).max(999),
    assets: z
      .array(
        z
          .object({
            slot: slotSchema,
            request: requestPathSchema,
            placement: placementSchema,
          })
          .strict(),
      )
      .min(3)
      .max(4),
  })
  .strict();

export type VisualSlot = (typeof leonardoImageSlots)[number];
export type ArticleVisualPlanSource = z.infer<typeof planSchema>;

export interface PlannedVisual {
  slot: VisualSlot;
  requestPath: string;
  placement: z.infer<typeof placementSchema>;
  generationRequest: LeonardoGenerationRequest;
}

export interface ArticleVisualPlan {
  path: string;
  dayNumber: number;
  assets: PlannedVisual[];
}

export interface VisualPlanStatus {
  planned: number;
  hero: number;
  inline: number;
  selected: number;
}

export async function loadArticleVisualPlan(article: LocalArticle): Promise<ArticleVisualPlan> {
  const planPath = resolve(article.directoryPath, 'images', 'visual-plan.json');
  let source: string;
  try {
    source = await readFile(planPath, 'utf8');
  } catch {
    throw new AppError('Every article requires images/visual-plan.json', ExitCode.InvalidConfiguration, {
      dayNumber: article.dayNumber,
      planPath,
    });
  }

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new AppError('Article visual plan is not valid JSON', ExitCode.InvalidConfiguration, { planPath });
  }
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppError('Article visual plan validation failed', ExitCode.InvalidConfiguration, {
      planPath,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  if (parsed.data.dayNumber !== article.dayNumber) {
    throw new AppError('Article visual plan day does not match its day-NNN directory', ExitCode.InvalidConfiguration, {
      planPath,
      planDayNumber: parsed.data.dayNumber,
      directoryDayNumber: article.dayNumber,
    });
  }

  const inlineCount = parsed.data.assets.filter((asset) => asset.slot.startsWith('inline-')).length;
  const expectedSlots: VisualSlot[] = [
    'hero',
    ...Array.from({ length: inlineCount }, (_value, index) => `inline-${String(index + 1).padStart(2, '0')}` as VisualSlot),
  ];
  const actualSlots = parsed.data.assets.map((asset) => asset.slot);
  if (inlineCount < 2 || inlineCount > 3 || actualSlots.join('|') !== expectedSlots.join('|')) {
    throw new AppError('Visual plan must contain hero followed by two or three contiguous inline slots', ExitCode.InvalidConfiguration, {
      planPath,
      actualSlots,
      expectedSlots,
    });
  }

  const planned: PlannedVisual[] = [];
  const assetNames = new Set<string>();
  for (const asset of parsed.data.assets) {
    const expectedRequest = `./prompts/${asset.slot}.json`;
    if (asset.request !== expectedRequest) {
      throw new AppError('Visual plan request filename must match its slot', ExitCode.InvalidConfiguration, {
        planPath,
        slot: asset.slot,
        request: asset.request,
        expectedRequest,
      });
    }
    if (asset.slot === 'hero' && asset.placement.kind !== 'article-start') {
      throw new AppError('The hero visual must use article-start placement', ExitCode.InvalidConfiguration, { planPath });
    }
    if (asset.slot !== 'hero') {
      if (asset.placement.kind !== 'after-heading' || !markdownHasHeading(article.markdown, asset.placement.heading)) {
        throw new AppError('Inline visual placement must name an existing level-two article heading', ExitCode.InvalidConfiguration, {
          planPath,
          slot: asset.slot,
          placement: asset.placement,
        });
      }
    }

    const requestPath = resolve(article.directoryPath, 'images', asset.request);
    assertInside(resolve(article.directoryPath, 'images', 'prompts'), requestPath, planPath);
    const generationRequest = await loadGenerationRequest(requestPath);
    if (generationRequest.dayNumber !== article.dayNumber || generationRequest.slot !== asset.slot) {
      throw new AppError('Visual request Day and slot must match its visual plan entry', ExitCode.InvalidConfiguration, {
        planPath,
        requestPath,
        planDayNumber: article.dayNumber,
        requestDayNumber: generationRequest.dayNumber,
        planSlot: asset.slot,
        requestSlot: generationRequest.slot,
      });
    }
    if (assetNames.has(generationRequest.assetName)) {
      throw new AppError('Visual request assetName values must be unique within one article', ExitCode.InvalidConfiguration, {
        planPath,
        assetName: generationRequest.assetName,
      });
    }
    assetNames.add(generationRequest.assetName);
    planned.push({ slot: asset.slot, requestPath, placement: asset.placement, generationRequest });
  }
  return { path: planPath, dayNumber: article.dayNumber, assets: planned };
}

export function validateSelectedVisualPlacement(
  article: LocalArticle,
  plan: ArticleVisualPlan,
  manifest: GeneratedImageManifest | undefined,
): VisualPlanStatus {
  const status = {
    planned: plan.assets.length,
    hero: 1,
    inline: plan.assets.length - 1,
    selected: manifest?.assets.length ?? 0,
  };
  if (!manifest) return status;

  const plannedBySlot = new Map(plan.assets.map((asset) => [asset.slot, asset]));
  const selectedSlots = new Set<VisualSlot>();
  const firstLevelTwoHeading = article.markdown.search(/^##\s+/mu);
  for (const asset of manifest.assets) {
    if (!asset.slot) {
      throw new AppError('Selected generated images require a visual-plan slot', ExitCode.InvalidConfiguration, {
        manifestPath: resolve(article.directoryPath, 'images', 'generated', 'manifest.json'),
        path: asset.path,
      });
    }
    if (selectedSlots.has(asset.slot)) {
      throw new AppError('Only one selected generated image may fill each visual-plan slot', ExitCode.InvalidConfiguration, {
        slot: asset.slot,
      });
    }
    selectedSlots.add(asset.slot);
    const plannedAsset = plannedBySlot.get(asset.slot);
    if (!plannedAsset) {
      throw new AppError('Selected generated image slot does not exist in the visual plan', ExitCode.InvalidConfiguration, {
        slot: asset.slot,
      });
    }
    const referenceIndex = article.markdown.indexOf(`](${asset.path})`);
    if (asset.slot === 'hero') {
      if (referenceIndex < 0 || (firstLevelTwoHeading >= 0 && referenceIndex > firstLevelTwoHeading)) {
        throw new AppError('The selected hero image must appear before the first level-two heading', ExitCode.InvalidConfiguration, {
          path: asset.path,
        });
      }
      continue;
    }
    if (plannedAsset.placement.kind !== 'after-heading') continue;
    const headingIndex = article.markdown.indexOf(plannedAsset.placement.heading);
    const nextHeadingIndex = article.markdown.indexOf('\n## ', headingIndex + plannedAsset.placement.heading.length);
    if (referenceIndex < headingIndex || (nextHeadingIndex >= 0 && referenceIndex > nextHeadingIndex)) {
      throw new AppError('Selected inline image must appear inside its planned article section', ExitCode.InvalidConfiguration, {
        path: asset.path,
        slot: asset.slot,
        heading: plannedAsset.placement.heading,
      });
    }
  }
  return status;
}

function markdownHasHeading(markdown: string, heading: string): boolean {
  return markdown.split('\n').some((line) => line.trim() === heading);
}

function assertInside(parent: string, child: string, planPath: string): void {
  const relativePath = relative(parent, child);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new AppError('Visual request path must stay inside images/prompts', ExitCode.InvalidConfiguration, {
      planPath,
      requestPath: child,
    });
  }
}
