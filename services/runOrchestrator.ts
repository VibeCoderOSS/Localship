import { QualityMode, RunCandidateScore } from '../types';

export interface RetryDecisionInput {
  qualityMode: QualityMode;
  isRepairCall: boolean;
  isIteration: boolean;
  attemptIndex: number;
  hasHardIssues: boolean;
  hasRuntimeIssues: boolean;
  noEffectiveChanges: boolean;
  inlineNoOp: boolean;
}

export interface RetryDecision {
  shouldRetry: boolean;
  reason: string;
}

export interface RetryPromptInput {
  basePrompt: string;
  protocolErrors: string[];
  patchErrors: string[];
  validationErrors: string[];
  runtimeErrors: string[];
  parserHints: string[];
  noEffectiveChanges: boolean;
  inlineNoOp: boolean;
  candidateFile?: string;
  findSnippet?: string;
  fileExcerpt?: string;
}

export interface RankedCandidate<T = string> {
  id: T;
  metrics: RunCandidateScore;
}

export const shouldTriggerSecondAttempt = (input: RetryDecisionInput): RetryDecision => {
  const {
    qualityMode,
    isRepairCall,
    isIteration,
    attemptIndex,
    hasHardIssues,
    hasRuntimeIssues,
    noEffectiveChanges,
    inlineNoOp
  } = input;

  if (isRepairCall) return { shouldRetry: false, reason: 'retry_disabled_for_repair_calls' };
  if (attemptIndex >= 2) return { shouldRetry: false, reason: 'retry_already_performed' };

  if (qualityMode === 'single-pass') {
    return { shouldRetry: false, reason: 'quality_mode_single_pass' };
  }

  if (qualityMode === 'always-best-of-2') {
    return { shouldRetry: true, reason: 'quality_mode_always_best_of_2' };
  }

  if (isIteration && attemptIndex === 1 && noEffectiveChanges) {
    return { shouldRetry: true, reason: 'iteration_no_diff_forced_retry' };
  }

  const hasRetrySignals = hasHardIssues || hasRuntimeIssues || noEffectiveChanges || inlineNoOp;
  if (!hasRetrySignals) return { shouldRetry: false, reason: 'primary_attempt_healthy' };

  return { shouldRetry: true, reason: 'adaptive_retry_on_failure_signals' };
};

export const buildSecondAttemptPrompt = (input: RetryPromptInput): string => {
  const parts: string[] = [];
  parts.push('SECOND ATTEMPT REQUIRED');
  parts.push('Fix the previous failure and output only valid marker blocks.');

  if (input.protocolErrors.length > 0) {
    parts.push(`[PROTOCOL]\n${input.protocolErrors.join('\n')}`);
  }
  if (input.patchErrors.length > 0) {
    parts.push(`[PATCH]\n${input.patchErrors.join('\n')}`);
  }
  if (input.validationErrors.length > 0) {
    parts.push(`[VALIDATION]\n${input.validationErrors.join('\n')}`);
  }
  if (input.runtimeErrors.length > 0) {
    parts.push(`[RUNTIME]\n${input.runtimeErrors.join('\n')}`);
  }
  if (input.parserHints.length > 0) {
    parts.push(`[PARSER_HINTS]\n${input.parserHints.join('\n')}`);
  }
  if (input.noEffectiveChanges) {
    parts.push('[NO_EFFECTIVE_CHANGES]\nThe previous output produced no actual file diffs.');
  }
  if (input.inlineNoOp) {
    parts.push('[INLINE_ANCHOR_MISS]\nAnchors did not match exactly. Use precise current snippets.');
  }
  if (input.candidateFile || input.findSnippet || input.fileExcerpt) {
    const ctx: string[] = [];
    if (input.candidateFile) ctx.push(`candidate_file=${input.candidateFile}`);
    if (input.findSnippet) ctx.push(`find_snippet:\n${input.findSnippet}`);
    if (input.fileExcerpt) ctx.push(`file_excerpt:\n${input.fileExcerpt}`);
    parts.push(`[INLINE_ANCHOR_CONTEXT]\n${ctx.join('\n')}`);
  }

  parts.push('STRICT OUTPUT');
  parts.push('- Existing files: <!-- patch: file --> with <replace><find><with>.');
  parts.push('- New files: <!-- filename: file --> fenced code.');
  parts.push('- No tool wrappers. No prose outside marker blocks.');
  parts.push('');
  parts.push(`[ORIGINAL REQUEST]\n${input.basePrompt}`);

  return parts.join('\n\n');
};

export const scoreRunCandidate = (
  validationDelta: number,
  runtimeOk: boolean,
  changedFiles: number,
  appliedOps: number,
  hardFailures: number
): RunCandidateScore => {
  let score = 0;
  score += changedFiles > 0 ? 240 : -120;
  score += Math.min(appliedOps, 6) * 16;
  score -= Math.max(0, validationDelta) * 140;
  score += runtimeOk ? 60 : -80;
  score -= hardFailures * 110;
  return {
    validationDelta,
    runtimeOk,
    changedFiles,
    appliedOps,
    hardFailures,
    score
  };
};

export const pickBestCandidate = <T = string>(candidates: RankedCandidate<T>[]): RankedCandidate<T> | null => {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.metrics.score - a.metrics.score);
  return sorted[0];
};
