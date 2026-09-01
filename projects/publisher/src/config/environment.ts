import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';

export function loadProjectEnvironment(
  workingDirectory = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const environmentFile = resolve(workingDirectory, environment.ENV_FILE ?? '../../infra/.env');
  loadDotEnv({ path: environmentFile, quiet: true });
  return environmentFile;
}
