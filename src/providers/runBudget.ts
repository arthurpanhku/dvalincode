import type { AuditSink } from '../audit/log.js';
import type { ResolvedPolicy } from '../core/policy.js';
import type { ChatRequest, ProviderAdapter } from './types.js';

export class RunBudgetError extends Error {
  constructor(readonly rule: string) {
    super(rule);
    this.name = 'RunBudgetError';
  }
}

export function hasRunBudget(policy: ResolvedPolicy): boolean {
  return policy.maxTokens !== undefined || policy.maxCostUsd !== undefined;
}

export function budgetedProvider(
  provider: ProviderAdapter,
  policy: ResolvedPolicy,
  audit?: AuditSink,
  env: NodeJS.ProcessEnv = process.env,
): ProviderAdapter {
  if (!hasRunBudget(policy)) return provider;
  let tokens = 0;
  let microdollars = 0;
  let invalidUsage = false;
  const inputRate = Number(env.DVALINCODE_BUDGET_INPUT_USD_PER_MILLION);
  const outputRate = Number(env.DVALINCODE_BUDGET_OUTPUT_USD_PER_MILLION);
  const maxCost = policy.maxCostUsd === undefined ? undefined : Math.floor(policy.maxCostUsd * 1_000_000);
  const maxTokens = policy.maxTokens ?? Number.MAX_SAFE_INTEGER;

  const reject = (rule: string): never => {
    audit?.append({ type: 'policy_violation', rule, tool: 'provider', target: provider.name });
    throw new RunBudgetError(rule);
  };

  return {
    name: provider.name,
    async chat(request) {
      if (invalidUsage) return reject('Provider usage was unavailable or exceeded its reservation');
      if (request.messages.some(message => message.images?.length)) return reject('Image attachment accounting is unavailable under a model budget');
      if (!provider.budgetInputUpperBound) return reject('Provider has no supported token budget accounting');
      if (maxCost !== undefined && (![inputRate, outputRate].every(rate => Number.isFinite(rate) && rate > 0))) {
        return reject('Cost budget requires operator-configured upper-bound input and output rates');
      }
      const input = provider.budgetInputUpperBound(request);
      if (!Number.isSafeInteger(input) || input <= 0) return reject('Provider could not bound prompt token use');
      const inputCost = maxCost === undefined ? 0 : Math.ceil(input * inputRate);
      const costOutputLimit = maxCost === undefined ? maxTokens : Math.floor((maxCost - microdollars - inputCost) / outputRate);
      const maxOutput = Math.min(request.maxTokens ?? 4096, maxTokens - tokens - input, costOutputLimit);
      if (!Number.isSafeInteger(maxOutput) || maxOutput < 1) return reject('Remaining run budget is too small for the next model request');

      // Reserve before the call. An error or missing usage retains the full
      // reservation because the service may already have processed the request.
      const reservedCost = inputCost + (maxCost === undefined ? 0 : Math.ceil(maxOutput * outputRate));
      if (maxCost !== undefined && microdollars + reservedCost > maxCost) {
        return reject('Remaining run budget is too small for the next model request');
      }
      tokens += input + maxOutput;
      microdollars += reservedCost;
      const response = await provider.chat({ ...request, maxTokens: maxOutput, singleAttempt: true });
      const usage = response.usage;
      if (!usage || ![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
          usage.inputTokens > input || usage.outputTokens > maxOutput) {
        invalidUsage = true;
        return reject('Provider usage was unavailable or exceeded its reservation');
      }

      tokens -= input + maxOutput - usage.inputTokens - usage.outputTokens;
      if (maxCost !== undefined) {
        microdollars -= reservedCost - Math.ceil(usage.inputTokens * inputRate) - Math.ceil(usage.outputTokens * outputRate);
      }
      audit?.append({ type: 'model_budget_usage', tokens, ...(maxCost === undefined ? {} : { microdollars }) });
      return response;
    },
  };
}

/** Conservative text-only bound for the supported direct adapters. */
export function textInputUpperBound(body: string, request: ChatRequest): number {
  return Buffer.byteLength(body, 'utf8') + 128 * (1 + request.messages.length + (request.tools?.length ?? 0));
}
