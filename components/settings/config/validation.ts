import { AppConfig } from '../../../types';
import { SettingsIssue } from './types';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const toNumber = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const withConfigDefaults = (config: AppConfig): AppConfig => {
  return {
    ...config,
    apiProvider: config.apiProvider ?? 'lmstudio',
    providerFamily: config.providerFamily ?? 'auto',
    samplingProfile: config.samplingProfile ?? 'provider-default',
    samplingOverrideEnabled: config.samplingOverrideEnabled ?? false,
    modelLookupMode: config.modelLookupMode ?? 'hf-cache',
    modelLookupTtlHours: config.modelLookupTtlHours ?? 168,
    qualityMode: config.qualityMode ?? 'adaptive-best-of-2',
    uiMode: config.uiMode ?? 'simple',
    autoRepairAttempts: config.autoRepairAttempts ?? 3,
    previewFailureMode: config.previewFailureMode ?? 'last-good',
    enableLiveWorkspaceApply: config.enableLiveWorkspaceApply ?? false,
    debugTextBudgetChars: config.debugTextBudgetChars ?? 400000,
    streamParseCadenceMs: config.streamParseCadenceMs ?? 120,
    ollamaContextSize: config.ollamaContextSize ?? 32000,
    showAdvancedDebug: config.showAdvancedDebug ?? false,
    showWireDebug: config.showWireDebug ?? false,
    modelTierPreference: config.modelTierPreference ?? 'auto'
  };
};

export const normalizeConfigDraft = (config: AppConfig): AppConfig => {
  const next = withConfigDefaults(config);

  next.modelLookupTtlHours = clamp(toNumber(next.modelLookupTtlHours, 168), 1, 720);
  next.autoRepairAttempts = clamp(toNumber(next.autoRepairAttempts, 3), 0, 5);
  next.debugTextBudgetChars = clamp(toNumber(next.debugTextBudgetChars, 400000), 20000, 2000000);
  next.streamParseCadenceMs = clamp(toNumber(next.streamParseCadenceMs, 120), 40, 1000);
  next.ollamaContextSize = clamp(toNumber(next.ollamaContextSize, 32000), 512, 262144);

  if (!next.samplingOverrideEnabled) {
    next.samplingProfile = 'provider-default';
  }
  if (!next.devMode) {
    next.showAdvancedDebug = false;
    next.showWireDebug = false;
  } else if (!next.showAdvancedDebug) {
    next.showWireDebug = false;
  }

  return next;
};

interface ValidationInput {
  config: AppConfig;
  detectedTier: 'small' | 'large' | 'unknown' | null;
}

export const validateConfigDraft = ({ config, detectedTier }: ValidationInput): SettingsIssue[] => {
  const issues: SettingsIssue[] = [];

  if (!config.apiUrl?.trim()) {
    issues.push({
      severity: 'error',
      field: 'apiUrl',
      message: 'API Endpoint is required.'
    });
  }

  if (!config.model?.trim()) {
    issues.push({
      severity: 'error',
      field: 'model',
      message: 'Model is required.'
    });
  }

  if ((config.apiProvider ?? 'lmstudio') === 'ollama') {
    const ctx = Number(config.ollamaContextSize);
    if (!Number.isFinite(ctx) || ctx < 512 || ctx > 262144) {
      issues.push({
        severity: 'error',
        field: 'ollamaContextSize',
        message: 'Ollama Context Size must be a number between 512 and 262144.'
      });
    }
    if ((config.apiUrl || '').includes('/v1/chat/completions')) {
      issues.push({
        severity: 'warning',
        field: 'apiUrl',
        message: 'Ollama provider selected: URL will be normalized to /api/chat at runtime.'
      });
    }
  }

  if (detectedTier === 'unknown' && (config.modelTierPreference ?? 'auto') === 'auto') {
    issues.push({
      severity: 'error',
      field: 'modelTierOverride',
      message: 'Unknown model size: select small-model or large-model mode.'
    });
  }

  if (config.showWireDebug && (!config.devMode || !config.showAdvancedDebug)) {
    issues.push({
      severity: 'warning',
      field: 'showWireDebug',
      message: 'Wire Stream Debug requires Developer Mode and Advanced Debug Suite.'
    });
  }

  if ((config.samplingProfile ?? 'provider-default') !== 'provider-default' && !config.samplingOverrideEnabled) {
    issues.push({
      severity: 'warning',
      field: 'samplingProfile',
      message: 'Sampling profile is ignored while Sampling Override is disabled.'
    });
  }

  return issues;
};

export const canSaveConfig = (issues: SettingsIssue[]): boolean => {
  return !issues.some((issue) => issue.severity === 'error');
};
