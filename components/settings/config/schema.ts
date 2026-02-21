import { AppConfig } from '../../../types';
import { FieldSpec, SectionSpec, SettingsFieldKey, SettingsTabId } from './types';

export const SETTINGS_TAB_LABELS: Record<SettingsTabId, string> = {
  basics: 'Basics',
  model: 'Model',
  runtime: 'Runtime',
  export: 'Export',
  developer: 'Developer'
};

export const SETTINGS_SECTIONS: SectionSpec[] = [
  {
    tab: 'basics',
    title: 'Core Settings',
    description: 'Connection, model, and high-level behavior.',
    fields: ['apiUrl', 'model', 'uiMode', 'qualityMode']
  },
  {
    tab: 'model',
    title: 'Model Behavior',
    description: 'Provider adaptation and lookup behavior.',
    fields: ['providerFamily', 'modelLookupMode', 'modelLookupTtlHours', 'samplingOverrideEnabled', 'samplingProfile', 'modelTierOverride']
  },
  {
    tab: 'runtime',
    title: 'Runtime Reliability',
    description: 'Repair and preview stability controls.',
    fields: ['autoRepairAttempts', 'previewFailureMode', 'enableLiveWorkspaceApply']
  },
  {
    tab: 'export',
    title: 'Export',
    description: 'Build target and output location.',
    fields: ['targetPlatform', 'outputDir', 'projectDir']
  },
  {
    tab: 'developer',
    title: 'Developer Diagnostics',
    description: 'Debug tools and parser instrumentation.',
    fields: ['devMode', 'showAdvancedDebug', 'showWireDebug', 'debugTextBudgetChars', 'streamParseCadenceMs']
  }
];

export const SETTINGS_FIELDS: Partial<Record<SettingsFieldKey, FieldSpec>> = {
  apiUrl: {
    key: 'apiUrl',
    tab: 'basics',
    controlType: 'input',
    label: 'API Endpoint',
    help: 'OpenAI-compatible endpoint, e.g. LM Studio local server.',
    placeholder: 'http://localhost:1234/v1/chat/completions'
  },
  model: {
    key: 'model',
    tab: 'basics',
    controlType: 'model',
    label: 'Model',
    help: 'Pick a discovered model or enter one manually.'
  },
  uiMode: {
    key: 'uiMode',
    tab: 'basics',
    controlType: 'select',
    label: 'UI Mode',
    options: [
      { value: 'simple', label: 'Simple (non-coder)' },
      { value: 'advanced', label: 'Advanced' }
    ]
  },
  qualityMode: {
    key: 'qualityMode',
    tab: 'basics',
    controlType: 'select',
    label: 'Quality Mode',
    options: [
      { value: 'single-pass', label: 'Single pass' },
      { value: 'adaptive-best-of-2', label: 'Adaptive best-of-2' },
      { value: 'always-best-of-2', label: 'Always best-of-2' }
    ]
  },
  providerFamily: {
    key: 'providerFamily',
    tab: 'model',
    controlType: 'select',
    label: 'Provider Family',
    options: [
      { value: 'auto', label: 'Auto detect' },
      { value: 'qwen', label: 'Qwen' },
      { value: 'generic', label: 'Generic' }
    ]
  },
  modelLookupMode: {
    key: 'modelLookupMode',
    tab: 'model',
    controlType: 'select',
    label: 'Model Lookup',
    options: [
      { value: 'off', label: 'Off (local only)' },
      { value: 'hf-cache', label: 'HF cache only' },
      { value: 'hf-live', label: 'HF live lookup' }
    ]
  },
  modelLookupTtlHours: {
    key: 'modelLookupTtlHours',
    tab: 'model',
    controlType: 'number',
    label: 'Lookup TTL (hours)',
    min: 1,
    max: 720,
    step: 1
  },
  samplingOverrideEnabled: {
    key: 'samplingOverrideEnabled',
    tab: 'model',
    controlType: 'toggle',
    label: 'Sampling Override',
    help: 'If off, provider defaults are used.'
  },
  samplingProfile: {
    key: 'samplingProfile',
    tab: 'model',
    controlType: 'select',
    label: 'Sampling Profile',
    options: [
      { value: 'provider-default', label: 'Provider default' },
      { value: 'strict-deterministic', label: 'Strict deterministic' }
    ],
    disabledIf: (config: AppConfig) => !config.samplingOverrideEnabled
  },
  modelTierOverride: {
    key: 'modelTierOverride',
    tab: 'model',
    controlType: 'tier-override',
    label: 'Unknown Model Tier'
  },
  autoRepairAttempts: {
    key: 'autoRepairAttempts',
    tab: 'runtime',
    controlType: 'number',
    label: 'Auto-repair Attempts',
    min: 0,
    max: 5,
    step: 1
  },
  previewFailureMode: {
    key: 'previewFailureMode',
    tab: 'runtime',
    controlType: 'select',
    label: 'Preview Failure Mode',
    options: [
      { value: 'last-good', label: 'Last known good' },
      { value: 'strict-fail', label: 'Strict fail (show error)' }
    ]
  },
  enableLiveWorkspaceApply: {
    key: 'enableLiveWorkspaceApply',
    tab: 'runtime',
    controlType: 'toggle',
    label: 'Live Workspace Apply',
    help: 'If off, files are committed after final candidate selection.'
  },
  targetPlatform: {
    key: 'targetPlatform',
    tab: 'export',
    controlType: 'select',
    label: 'Target Platform',
    options: [
      { value: 'mac-arm64', label: 'macOS (Apple Silicon) - .dmg' },
      { value: 'mac-intel', label: 'macOS (Intel) - .dmg' },
      { value: 'windows', label: 'Windows - .exe' },
      { value: 'linux', label: 'Linux - .AppImage' }
    ],
    visibleIf: (_config, isElectron) => isElectron
  },
  outputDir: {
    key: 'outputDir',
    tab: 'export',
    controlType: 'folder-picker',
    label: 'Output Folder',
    help: 'Used for native build artifacts.',
    visibleIf: (_config, isElectron) => isElectron
  },
  projectDir: {
    key: 'projectDir',
    tab: 'export',
    controlType: 'readonly',
    label: 'Working Folder',
    visibleIf: (_config, isElectron) => isElectron
  },
  devMode: {
    key: 'devMode',
    tab: 'developer',
    controlType: 'toggle',
    label: 'Developer Mode',
    help: 'Enable code editor and file explorer view.'
  },
  showAdvancedDebug: {
    key: 'showAdvancedDebug',
    tab: 'developer',
    controlType: 'toggle',
    label: 'Advanced Debug Suite',
    help: 'Show persistent raw/parsed diagnostics.',
    disabledIf: (config: AppConfig) => !config.devMode
  },
  showWireDebug: {
    key: 'showWireDebug',
    tab: 'developer',
    controlType: 'toggle',
    label: 'Wire Stream Debug',
    help: 'Show SSE wire frames in diagnostics.',
    disabledIf: (config: AppConfig) => !config.devMode || !config.showAdvancedDebug
  },
  debugTextBudgetChars: {
    key: 'debugTextBudgetChars',
    tab: 'developer',
    controlType: 'number',
    label: 'Debug Text Budget (chars)',
    min: 20000,
    max: 2000000,
    step: 10000
  },
  streamParseCadenceMs: {
    key: 'streamParseCadenceMs',
    tab: 'developer',
    controlType: 'number',
    label: 'Stream Parse Cadence (ms)',
    min: 40,
    max: 1000,
    step: 10
  }
};

export const getFieldsForTab = (
  tab: SettingsTabId,
  config: AppConfig,
  isElectron: boolean
): FieldSpec[] => {
  const section = SETTINGS_SECTIONS.find((item) => item.tab === tab);
  if (!section) return [];
  return section.fields
    .map((key) => SETTINGS_FIELDS[key])
    .filter((field): field is FieldSpec => !!field)
    .filter((field) => (field.visibleIf ? field.visibleIf(config, isElectron) : true));
};
