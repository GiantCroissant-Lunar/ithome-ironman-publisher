import { resolve } from 'node:path';
import { errorDetails, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { validateSkillsDirectory } from '../skills/validate-skills.js';

async function main(): Promise<void> {
  const skillsDirectory = resolve(process.cwd(), process.env.SKILLS_DIR ?? '../../.agents/skills');
  const skills = await validateSkillsDirectory(skillsDirectory);
  createLogger(process.env.LOG_LEVEL ?? 'info').info(
    { skillsDirectory, count: skills.length, skills: skills.map(({ name, path }) => ({ name, path })) },
    'All repository agent skills are valid',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
