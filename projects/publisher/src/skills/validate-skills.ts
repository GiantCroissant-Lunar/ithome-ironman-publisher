import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { AppError, ExitCode } from '../infra/errors.js';

const frontmatterSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().min(30),
  })
  .passthrough();

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export async function validateSkillsDirectory(skillsDirectory: string): Promise<SkillSummary[]> {
  let entries;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch {
    throw new AppError('Agent skills directory could not be read', ExitCode.InvalidConfiguration, { skillsDirectory });
  }

  const directories = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  if (directories.length === 0) {
    throw new AppError('Agent skills directory contains no skills', ExitCode.InvalidConfiguration, { skillsDirectory });
  }

  const summaries: SkillSummary[] = [];
  for (const directory of directories) {
    const skillPath = join(skillsDirectory, directory.name);
    const skillFile = join(skillPath, 'SKILL.md');
    const metadataFile = join(skillPath, 'agents', 'openai.yaml');
    let source: string;
    let metadata: string;
    try {
      [source, metadata] = await Promise.all([readFile(skillFile, 'utf8'), readFile(metadataFile, 'utf8')]);
    } catch {
      throw new AppError('Agent skill is missing SKILL.md or agents/openai.yaml', ExitCode.InvalidConfiguration, {
        skillPath,
      });
    }

    if (/\bTODO\b|\[TODO/iu.test(source) || /\bTODO\b|\[TODO/iu.test(metadata)) {
      throw new AppError('Agent skill contains an unfinished placeholder', ExitCode.InvalidConfiguration, { skillPath });
    }
    const parsed = matter(source);
    const frontmatter = frontmatterSchema.safeParse(parsed.data);
    if (!frontmatter.success || frontmatter.data.name !== directory.name) {
      throw new AppError('Agent skill frontmatter validation failed', ExitCode.InvalidConfiguration, {
        skillPath,
        expectedName: directory.name,
        issues: frontmatter.success ? ['name must match directory'] : frontmatter.error.issues,
      });
    }
    if (parsed.content.trim().length < 100) {
      throw new AppError('Agent skill instructions are unexpectedly empty', ExitCode.InvalidConfiguration, { skillPath });
    }
    if (!/^interface:\s*$/mu.test(metadata) || !/^\s+display_name:/mu.test(metadata) || !/^\s+short_description:/mu.test(metadata)) {
      throw new AppError('Agent skill UI metadata is incomplete', ExitCode.InvalidConfiguration, { metadataFile });
    }

    summaries.push({
      name: frontmatter.data.name,
      description: frontmatter.data.description,
      path: skillPath,
    });
  }
  return summaries;
}
