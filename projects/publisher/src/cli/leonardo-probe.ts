import { loadProjectEnvironment } from '../config/environment.js';
import { errorDetails, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { loadLeonardoConfig } from '../leonardo/config.js';
import { PlaywrightLeonardoSite } from '../leonardo/playwright-leonardo-site.js';

loadProjectEnvironment();

async function main(): Promise<void> {
  const config = loadLeonardoConfig();
  const logger = createLogger(config.logLevel);
  let site: PlaywrightLeonardoSite | undefined;
  let failed = false;
  try {
    site = await PlaywrightLeonardoSite.create(config, logger);
    const result = await site.captureProbe();
    logger.info({ probePath: `${result.directory}/probe.json` }, 'Leonardo read-only probe completed; no tokens were consumed');
  } catch (error: unknown) {
    failed = true;
    if (site) await site.captureDiagnostics(error).catch(() => undefined);
    throw error;
  } finally {
    if (site) await site.close(failed);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
