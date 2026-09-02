import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSkillsDirectory } from '../src/skills/validate-skills.js';

describe('repository agent skills', () => {
  it('have valid names, frontmatter, instructions, and UI metadata', async () => {
    const skills = await validateSkillsDirectory(resolve(process.cwd(), '../../.agents/skills'));
    expect(skills.map((skill) => skill.name)).toEqual([
      'ithome-article-author',
      'ithome-article-illustrator',
      'ithome-auth-session',
      'ithome-draft-sync',
      'ithome-publish',
      'ithome-publish-diagnostics',
      'ithome-republish-recovery',
      'ithome-site-discovery',
    ]);
  });
});
