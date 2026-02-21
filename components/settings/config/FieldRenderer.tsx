import React from 'react';
import { AppConfig } from '../../../types';
import { ModelProfile, getModelProfile } from '../../../services/llmService';
import { FieldSpec } from './types';
import InputField from './fields/InputField';
import NumberField from './fields/NumberField';
import SelectField from './fields/SelectField';
import ToggleField from './fields/ToggleField';

interface FieldRendererProps {
  field: FieldSpec;
  config: AppConfig;
  projectDir?: string;
  isElectron: boolean;
  availableModels: string[];
  isLoadingModels: boolean;
  fetchError: string | null;
  detectedProfile: ModelProfile | null;
  effectiveTier: string | null;
  effectiveSource: string | null;
  requiresTierChoice: boolean;
  onRefreshModels: () => void;
  onSelectOutput: () => void;
  setField: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
}

const FieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  config,
  projectDir,
  isElectron,
  availableModels,
  isLoadingModels,
  fetchError,
  detectedProfile,
  effectiveTier,
  effectiveSource,
  requiresTierChoice,
  onRefreshModels,
  onSelectOutput,
  setField
}) => {
  if (field.visibleIf && !field.visibleIf(config, isElectron)) return null;

  const disabled = field.disabledIf ? field.disabledIf(config) : false;

  if (field.controlType === 'input' && field.key === 'apiUrl') {
    return (
      <InputField
        id={field.key}
        label={field.label}
        help={field.help}
        value={String(config.apiUrl || '')}
        placeholder={field.placeholder}
        mono
        onChange={(value) => setField('apiUrl', value)}
      />
    );
  }

  if (field.controlType === 'readonly' && field.key === 'projectDir') {
    return (
      <InputField
        id={field.key}
        label={field.label}
        value={projectDir || ''}
        placeholder="Not set"
        readOnly
      />
    );
  }

  if (field.controlType === 'folder-picker' && field.key === 'outputDir') {
    return (
      <div>
        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">{field.label}</label>
        <div className="flex gap-2">
          <input
            type="text"
            readOnly
            value={config.outputDir || ''}
            placeholder="Default (Downloads Folder)"
            className="flex-1 bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white text-sm"
          />
          <button
            type="button"
            onClick={onSelectOutput}
            className="px-4 py-2 bg-slate-200 dark:bg-ocean-800 hover:bg-slate-300 dark:hover:bg-ocean-700 text-slate-700 dark:text-slate-200 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
          >
            Select Folder
          </button>
        </div>
      </div>
    );
  }

  if (field.controlType === 'model' && field.key === 'model') {
    return (
      <div>
        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">{field.label}</label>
        <div className="flex gap-2">
          {availableModels.length > 0 ? (
            <div className="relative flex-1">
              <select
                value={config.model}
                onChange={(e) => {
                  const nextModel = e.target.value;
                  const profile = getModelProfile(nextModel);
                  setField('model', nextModel);
                  if (profile.tier !== 'unknown') {
                    setField('modelTierPreference', 'auto');
                  }
                }}
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white outline-none appearance-none text-sm"
              >
                {availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-400">
                <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" /></svg>
              </div>
            </div>
          ) : (
            <input
              type="text"
              value={config.model}
              onChange={(e) => setField('model', e.target.value)}
              className="flex-1 bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white text-sm"
              placeholder="local-model"
            />
          )}
          <button
            type="button"
            onClick={onRefreshModels}
            disabled={isLoadingModels}
            className="px-3 py-2 bg-slate-100 dark:bg-ocean-800 border border-slate-300 dark:border-ocean-700 rounded-lg text-slate-500 dark:text-slate-300 hover:text-blue-600 dark:hover:text-white transition-colors disabled:opacity-50"
            title="Refresh Models"
          >
            {isLoadingModels ? (
              <div className="animate-spin h-5 w-5 border-2 border-slate-400 border-t-transparent rounded-full" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
          </button>
        </div>
        {fetchError && <p className="text-[10px] text-red-500 mt-2 font-medium">{fetchError}</p>}
        {!fetchError && availableModels.length > 0 && <p className="text-[10px] text-green-600 dark:text-teal-400 mt-2 font-bold">Models detected.</p>}
        {detectedProfile && (
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
            Detected: <span className="font-semibold">{detectedProfile.tier.toUpperCase()}</span>
            {detectedProfile.approxParamsB !== null ? ` (~${detectedProfile.approxParamsB.toFixed(1)}B)` : ''} via {detectedProfile.source}.
          </p>
        )}
        {effectiveTier && (
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
            Effective: <span className="font-semibold">{String(effectiveTier).toUpperCase()}</span> via {effectiveSource}.
          </p>
        )}
      </div>
    );
  }

  if (field.controlType === 'tier-override' && field.key === 'modelTierOverride') {
    if (detectedProfile?.tier !== 'unknown') return null;
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-3">
        <p className="text-[10px] text-amber-700 dark:text-amber-300 font-bold uppercase tracking-wide mb-2">
          Unknown model size: choose behavior profile
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setField('modelTierPreference', 'small')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold border ${config.modelTierPreference === 'small' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-ocean-900 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-ocean-700'}`}
          >
            Small-model mode
          </button>
          <button
            type="button"
            onClick={() => setField('modelTierPreference', 'large')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold border ${config.modelTierPreference === 'large' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-ocean-900 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-ocean-700'}`}
          >
            Large-model mode
          </button>
        </div>
        {requiresTierChoice && (
          <p className="text-[10px] text-amber-700 dark:text-amber-300 mt-2">
            Select one mode to save this configuration.
          </p>
        )}
      </div>
    );
  }

  if (field.controlType === 'toggle' && field.key in config) {
    return (
      <ToggleField
        id={field.key}
        label={field.label}
        help={field.help}
        checked={Boolean(config[field.key as keyof AppConfig])}
        disabled={disabled}
        onChange={(checked) => setField(field.key as keyof AppConfig, checked as never)}
      />
    );
  }

  if (field.controlType === 'select' && field.options && field.key in config) {
    return (
      <SelectField
        id={field.key}
        label={field.label}
        help={field.help}
        value={String(config[field.key as keyof AppConfig] ?? '')}
        options={field.options}
        disabled={disabled}
        onChange={(value) => setField(field.key as keyof AppConfig, value as never)}
      />
    );
  }

  if (field.controlType === 'number' && field.key in config) {
    const value = Number(config[field.key as keyof AppConfig] ?? 0);
    return (
      <NumberField
        id={field.key}
        label={field.label}
        help={field.help}
        value={Number.isFinite(value) ? value : 0}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        onChange={(next) => setField(field.key as keyof AppConfig, next as never)}
      />
    );
  }

  return null;
};

export default FieldRenderer;
