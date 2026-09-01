import { resolve } from 'node:path';
import { z } from 'zod';
import { AppError, ExitCode } from '../infra/errors.js';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const rawLeonardoConfigSchema = z.object({
  LEONARDO_HOME_URL: z.url().default('https://app.leonardo.ai/'),
  LEONARDO_GENERATE_URL: z.url().default('https://app.leonardo.ai/generate?model=auto-preset'),
  LEONARDO_AUTH_PROFILE_DIR: z.string().trim().min(1).default('../../infra/.auth/leonardo-edge-profile'),
  LEONARDO_AUTH_STATE_PATH: z.string().trim().min(1).default('../../infra/.auth/leonardo-storage-state.json'),
  LEONARDO_OUTPUT_DIR: z.string().trim().min(1).default('../../infra/generated'),
  LEONARDO_DIAGNOSTICS_DIR: z.string().trim().min(1).default('../../infra/diagnostics/leonardo'),
  LEONARDO_BROWSER_CHANNEL: z.enum(['msedge', 'chromium']).default('msedge'),
  LEONARDO_HEADLESS: booleanString.default(false),
  LEONARDO_ACTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  LEONARDO_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(60_000),
  LEONARDO_AUTH_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(600_000),
  LEONARDO_GENERATION_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(300_000),
  TRACE_MODE: z.enum(['off', 'retain-on-failure', 'always']).default('retain-on-failure'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface LeonardoConfig {
  homeUrl: string;
  generateUrl: string;
  authProfileDirectory: string;
  authStatePath: string;
  outputDirectory: string;
  diagnosticsDirectory: string;
  browserChannel: 'msedge' | 'chromium';
  headless: boolean;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  authTimeoutMs: number;
  generationTimeoutMs: number;
  traceMode: 'off' | 'retain-on-failure' | 'always';
  logLevel: string;
}

export function loadLeonardoConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): LeonardoConfig {
  const parsed = rawLeonardoConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new AppError('Leonardo configuration validation failed', ExitCode.InvalidConfiguration, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const value = parsed.data;
  return {
    homeUrl: value.LEONARDO_HOME_URL,
    generateUrl: value.LEONARDO_GENERATE_URL,
    authProfileDirectory: resolve(workingDirectory, value.LEONARDO_AUTH_PROFILE_DIR),
    authStatePath: resolve(workingDirectory, value.LEONARDO_AUTH_STATE_PATH),
    outputDirectory: resolve(workingDirectory, value.LEONARDO_OUTPUT_DIR),
    diagnosticsDirectory: resolve(workingDirectory, value.LEONARDO_DIAGNOSTICS_DIR),
    browserChannel: value.LEONARDO_BROWSER_CHANNEL,
    headless: value.LEONARDO_HEADLESS,
    actionTimeoutMs: value.LEONARDO_ACTION_TIMEOUT_MS,
    navigationTimeoutMs: value.LEONARDO_NAVIGATION_TIMEOUT_MS,
    authTimeoutMs: value.LEONARDO_AUTH_TIMEOUT_MS,
    generationTimeoutMs: value.LEONARDO_GENERATION_TIMEOUT_MS,
    traceMode: value.TRACE_MODE,
    logLevel: value.LOG_LEVEL,
  };
}
