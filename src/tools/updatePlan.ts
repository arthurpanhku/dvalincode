import { z } from 'zod';
import type { ChatMessage } from '../providers/types.js';
import type { Tool } from './types.js';

const stepSchema = z
  .object({
    step: z.string().trim().min(1).max(300).describe('What this step does, in a few words.'),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .strict();

const inputSchema = z
  .object({
    explanation: z.string().max(1_000).optional().describe('Optional note on why the checklist changed.'),
    plan: z.array(stepSchema).min(1).max(50).describe('The whole checklist, in order, every time.'),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.plan.filter(step => step.status === 'in_progress').length > 1) {
      ctx.addIssue({ code: 'custom', message: 'At most one step can be in_progress at a time.' });
    }
  });

type Input = z.infer<typeof inputSchema>;
export type PlanStep = z.infer<typeof stepSchema>;

export const updatePlanTool: Tool<Input> = {
  name: 'update_plan',
  description:
    'Keep a checklist for a task with three or more steps; skip it for quick tasks. Send the whole list each time: mark the step you are working on in_progress (one at a time) and finished steps completed, and remove steps that no longer apply. The user sees the checklist.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => false,
  async run(input) {
    const done = input.plan.filter(step => step.status === 'completed').length;
    const current = input.plan.find(step => step.status === 'in_progress');
    return {
      title: `Checklist: ${done}/${input.plan.length} done`,
      output: `Checklist updated: ${done} of ${input.plan.length} steps done.${current ? ` In progress: ${current.step}` : ''}`,
      metadata: { plan: input.plan },
    };
  },
};

/** The checklist as plain text, one `- [x]` / `- [~]` / `- [ ]` line per step. */
export function renderChecklist(plan: PlanStep[]): string {
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const;
  return plan.map(step => `- ${mark[step.status]} ${step.step}`).join('\n');
}

/** The checklist from the most recent valid update_plan call in `messages`. */
export function latestChecklist(messages: ChatMessage[]): PlanStep[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    for (let j = message.tool_calls.length - 1; j >= 0; j--) {
      const call = message.tool_calls[j];
      if (call.name !== updatePlanTool.name) continue;
      try {
        const parsed = inputSchema.safeParse(JSON.parse(call.arguments));
        if (parsed.success) return parsed.data.plan;
      } catch {
        // Malformed arguments: the call failed, so look further back.
      }
    }
  }
  return undefined;
}

/**
 * Append the current checklist to a compaction summary, so the model keeps it
 * after older messages are summarized away. Nothing is added when there is no
 * checklist, or when the messages kept verbatim already hold the latest one.
 */
export function carryChecklist(summary: string, compacted: ChatMessage[], kept: ChatMessage[] = []): string {
  const plan = latestChecklist(compacted);
  if (!plan || latestChecklist(kept)) return summary;
  return `${summary}\n\nTask checklist when the conversation was compacted (keep it current with update_plan):\n${renderChecklist(plan)}`;
}

/** The nudge sent when the model stops while its checklist still has open steps. */
export function unfinishedChecklistNudge(open: PlanStep[]): string {
  return [
    `Runtime completion check: your checklist still has ${open.length} unfinished step${open.length === 1 ? '' : 's'}:`,
    renderChecklist(open),
    'Continue with the next step now. If steps are already done or no longer apply, call update_plan to mark them completed or remove them before giving your final answer.',
  ].join('\n');
}
