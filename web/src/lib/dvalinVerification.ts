import type { DvalinScanResult } from '../types.ts';

export type DvalinVerificationSummary = {
  status: 'not-run' | 'running' | 'evidence-ready' | 'needs-attention';
  label: string;
  detail: string;
  scanPassed: boolean;
  draftPrReady: boolean;
  notices: string[];
};

export function dvalinVerificationSummary(input: {
  result: DvalinScanResult | null;
  modelReviewComplete: boolean;
  running: boolean;
  gitBranch?: string | null;
}): DvalinVerificationSummary {
  const { result } = input;
  const scanPassed = Boolean(
    result
    && result.findings.length === 0
    && result.coverage?.status === 'complete'
    && result.gate?.passed,
  );
  const notices: string[] = [];

  if (result?.gate?.threshold === 'none') {
    notices.push('The security gate is advisory because its threshold is none.');
  }
  if (input.modelReviewComplete) {
    notices.push('No offline Verified Fix Record is attached to this web verification.');
  }
  if (!input.gitBranch) {
    notices.push('Draft PR requires an active Git branch.');
  }

  if (input.running) {
    return {
      status: 'running',
      label: 'Verification running',
      detail: 'The model review and deterministic re-scan are still collecting evidence.',
      scanPassed,
      draftPrReady: false,
      notices,
    };
  }
  if (input.modelReviewComplete && scanPassed) {
    return {
      status: 'evidence-ready',
      label: 'Verification evidence ready',
      detail: 'Model review completed and the deterministic scan evidence passed.',
      scanPassed,
      draftPrReady: Boolean(input.gitBranch),
      notices,
    };
  }
  if (result || input.modelReviewComplete) {
    return {
      status: 'needs-attention',
      label: 'Verification needs attention',
      detail: input.modelReviewComplete
        ? 'The model review finished, but deterministic scan evidence is incomplete or failing.'
        : 'A scan exists, but a model-driven Verify turn has not completed for it.',
      scanPassed,
      draftPrReady: false,
      notices,
    };
  }
  return {
    status: 'not-run',
    label: 'Not verified',
    detail: 'Run Verify to collect model review, project-check, and deterministic scan evidence.',
    scanPassed,
    draftPrReady: false,
    notices,
  };
}

export function dvalinEmptyFindingCopy(result: Pick<DvalinScanResult, 'coverage'>): { title: string; detail: string } {
  if (result.coverage?.status === 'complete') {
    return {
      title: 'No actionable findings',
      detail: 'All selected engines completed; review the verification report before publishing.',
    };
  }
  const status = result.coverage?.status ?? 'unknown';
  return {
    title: 'No findings in covered scope',
    detail: `${status[0]?.toUpperCase() ?? ''}${status.slice(1)} coverage is not full assurance. Review the deferred and excluded work below.`,
  };
}
