import { resolve } from 'node:path';
import { z } from 'zod';
import { AppError, ExitCode } from '../infra/errors.js';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().min(1).optional());
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'Expected a 24-hour HH:mm value');

const rawConfigSchema = z.object({
  ITHOME_PROFILE_URL: z.url(),
  ITHOME_USER_IDENTIFIER: z.string().trim().min(1),
  IRONMAN_YEAR: z.coerce.number().int().min(2008).max(2100).default(2026),
  IRONMAN_SERIES_TITLE: optionalText,
  ITHOME_SERIES_URL: optionalUrl,
  ITHOME_DRAFTS_URL: optionalUrl,
  ITHOME_NEW_ARTICLE_URL: optionalUrl,
  ARTICLES_DIR: z.string().trim().min(1).default('../../articles'),
  IRONMAN_START_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  IRONMAN_MAX_DAY: z.coerce.number().int().min(1).max(100).default(30),
  TIME_ZONE: z.literal('Asia/Taipei').default('Asia/Taipei'),
  SCHEDULE_PRIMARY: hhmm.default('10:17'),
  SCHEDULE_FALLBACK: hhmm.default('20:47'),
  PUBLISH_DRY_RUN: booleanString.default(true),
  PUBLISHED_UPDATE_POLICY: z.literal('report').default('report'),
  BROWSER_CHANNEL: z.enum(['msedge', 'chromium']).default('msedge'),
  HEADLESS: booleanString.default(false),
  AUTH_STATE_PATH: z.string().trim().min(1).default('../../infra/.auth/storage-state.json'),
  DIAGNOSTICS_DIR: z.string().trim().min(1).default('../../infra/diagnostics'),
  STATE_PATH: z.string().trim().min(1).default('../../infra/state/publisher-state.json'),
  LOCK_PATH: z.string().trim().min(1).default('../../infra/state/publisher.lock'),
  LOCK_STALE_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(7_200_000),
  ACTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(30_000),
  VERIFICATION_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  VERIFICATION_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  TRACE_MODE: z.enum(['off', 'retain-on-failure', 'always']).default('retain-on-failure'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface AppConfig {
  profileUrl: string;
  userIdentifier: string;
  ironmanYear: number;
  seriesTitle?: string;
  seriesUrl?: string;
  draftsUrl?: string;
  newArticleUrl?: string;
  articlesDir: string;
  startDate: string;
  maximumDay: number;
  timeZone: 'Asia/Taipei';
  primarySchedule: string;
  fallbackSchedule: string;
  publishDryRun: boolean;
  publishedUpdatePolicy: 'report';
  browserChannel: 'msedge' | 'chromium';
  headless: boolean;
  authStatePath: string;
  diagnosticsDir: string;
  statePath: string;
  lockPath: string;
  lockStaleMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  verificationAttempts: number;
  verificationDelayMs: number;
  traceMode: 'off' | 'retain-on-failure' | 'always';
  logLevel: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const result = rawConfigSchema.safeParse(environment);
  if (!result.success) {
    throw new AppError('Configuration validation failed', ExitCode.InvalidConfiguration, {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }

  const value = result.data;
  return {
    profileUrl: value.ITHOME_PROFILE_URL,
    userIdentifier: value.ITHOME_USER_IDENTIFIER,
    ironmanYear: value.IRONMAN_YEAR,
    ...(value.IRONMAN_SERIES_TITLE ? { seriesTitle: value.IRONMAN_SERIES_TITLE } : {}),
    ...(value.ITHOME_SERIES_URL ? { seriesUrl: value.ITHOME_SERIES_URL } : {}),
    ...(value.ITHOME_DRAFTS_URL ? { draftsUrl: value.ITHOME_DRAFTS_URL } : {}),
    ...(value.ITHOME_NEW_ARTICLE_URL ? { newArticleUrl: value.ITHOME_NEW_ARTICLE_URL } : {}),
    articlesDir: resolve(workingDirectory, value.ARTICLES_DIR),
    startDate: value.IRONMAN_START_DATE,
    maximumDay: value.IRONMAN_MAX_DAY,
    timeZone: value.TIME_ZONE,
    primarySchedule: value.SCHEDULE_PRIMARY,
    fallbackSchedule: value.SCHEDULE_FALLBACK,
    publishDryRun: value.PUBLISH_DRY_RUN,
    publishedUpdatePolicy: value.PUBLISHED_UPDATE_POLICY,
    browserChannel: value.BROWSER_CHANNEL,
    headless: value.HEADLESS,
    authStatePath: resolve(workingDirectory, value.AUTH_STATE_PATH),
    diagnosticsDir: resolve(workingDirectory, value.DIAGNOSTICS_DIR),
    statePath: resolve(workingDirectory, value.STATE_PATH),
    lockPath: resolve(workingDirectory, value.LOCK_PATH),
    lockStaleMs: value.LOCK_STALE_MS,
    actionTimeoutMs: value.ACTION_TIMEOUT_MS,
    navigationTimeoutMs: value.NAVIGATION_TIMEOUT_MS,
    verificationAttempts: value.VERIFICATION_ATTEMPTS,
    verificationDelayMs: value.VERIFICATION_DELAY_MS,
    traceMode: value.TRACE_MODE,
    logLevel: value.LOG_LEVEL,
  };
}
