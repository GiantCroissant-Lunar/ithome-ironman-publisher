import { describe, expect, it, vi } from 'vitest';
import type { LeonardoGenerationRequest } from '../src/leonardo/generation-request.js';
import type { LeonardoGenerator } from '../src/leonardo/generation-workflow.js';
import { runGenerationWorkflow } from '../src/leonardo/generation-workflow.js';

const request: LeonardoGenerationRequest = {
  version: 1,
  dayNumber: 1,
  slot: 'hero',
  assetName: 'workflow-hero',
  prompt: 'A detailed editorial illustration of an agent workflow',
  aspectRatio: '16:9',
  style: 'Dynamic',
  model: 'Auto',
  maxCandidates: 1,
  alt: 'Agent workflow illustration',
};

describe('Leonardo generation workflow safety gate', () => {
  it('does not even create a browser generator in preview mode', async () => {
    const createGenerator = vi.fn<() => Promise<LeonardoGenerator>>();
    const result = await runGenerationWorkflow(request, false, createGenerator);
    expect(result).toEqual({ mode: 'preview', request });
    expect(createGenerator).not.toHaveBeenCalled();
  });

  it('calls the mock browser workflow exactly once only in explicit live mode', async () => {
    const run = {
      version: 1 as const,
      runId: '2026-09-01T12-00-00-000Z',
      generatedAt: '2026-09-01T12:00:00.000Z',
      pageUrl: 'https://app.leonardo.ai/generation/image/test-00000000-0000-0000-0000-000000000001',
      request,
      candidates: [
        {
          index: 1,
          fileName: 'candidate-01.png',
          sha256: 'a'.repeat(64),
          width: 1536,
          height: 864,
        },
      ],
    };
    const generate = vi.fn<LeonardoGenerator['generate']>().mockResolvedValue(run);
    const createGenerator = vi.fn<() => Promise<LeonardoGenerator>>().mockResolvedValue({ generate });
    const result = await runGenerationWorkflow(request, true, createGenerator);
    expect(createGenerator).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(request);
    expect(result).toEqual({ mode: 'generated', request, run });
  });
});
