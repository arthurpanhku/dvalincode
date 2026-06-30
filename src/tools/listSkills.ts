import { z } from 'zod';
import { listSkills } from '../skills/store.js';
import type { Tool } from './types.js';

const inputSchema = z.object({}).strict();
type Input = z.infer<typeof inputSchema>;

export const listSkillsTool: Tool<Input> = {
  name: 'list_skills',
  description: 'List installed DvalinCode skills and the tools they recommend.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  async run() {
    const skills = await listSkills();
    return {
      title: 'Installed skills',
      output: skills.length
        ? skills.map(skill => `- ${skill.name}: ${skill.description}${skill.tools?.length ? ` (tools: ${skill.tools.join(', ')})` : ''}`).join('\n')
        : 'No skills installed.',
      metadata: { skills },
    };
  },
};
