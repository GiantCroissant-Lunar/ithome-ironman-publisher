import type { LeonardoGenerationRequest } from './generation-request.js';
import type { LeonardoGenerationRun } from './generation-run.js';

export interface LeonardoGenerator {
  generate(request: LeonardoGenerationRequest): Promise<LeonardoGenerationRun>;
}

export interface GenerationWorkflowResult {
  mode: 'preview' | 'generated';
  request: LeonardoGenerationRequest;
  run?: LeonardoGenerationRun;
}

export async function runGenerationWorkflow(
  request: LeonardoGenerationRequest,
  live: boolean,
  createGenerator: () => Promise<LeonardoGenerator>,
): Promise<GenerationWorkflowResult> {
  if (!live) return { mode: 'preview', request };
  const generator = await createGenerator();
  return { mode: 'generated', request, run: await generator.generate(request) };
}
