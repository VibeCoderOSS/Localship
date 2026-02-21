import React, { useEffect, useMemo } from 'react';
import { AppConfig } from '../types';
import FieldRenderer from './settings/config/FieldRenderer';
import SettingsSection from './settings/config/SettingsSection';
import SettingsTabs from './settings/config/SettingsTabs';
import { SETTINGS_SECTIONS, SETTINGS_TAB_LABELS, getFieldsForTab } from './settings/config/schema';
import { SettingsTabId } from './settings/config/types';
import { useConfigDraft } from './settings/config/useConfigDraft';
import { useModelOptions } from './settings/config/useModelOptions';
import { canSaveConfig, validateConfigDraft, withConfigDefaults } from './settings/config/validation';

interface ConfigModalProps {
  config: AppConfig;
  projectDir?: string;
  onSave: (config: AppConfig) => void;
  isOpen: boolean;
  onClose: () => void;
}

const ConfigModal: React.FC<ConfigModalProps> = ({ config, projectDir, onSave, isOpen, onClose }) => {
  const isElectron = !!window.electronAPI;

  const {
    localConfig,
    setField,
    setLocalConfig,
    activeTab,
    setActiveTab,
    showAdvanced,
    setShowAdvanced,
    normalizedConfig
  } = useConfigDraft({
    config,
    isOpen
  });

  const {
    availableModels,
    isLoadingModels,
    fetchError,
    refreshModels,
    detectedProfile,
    effectiveTier,
    effectiveSource,
    requiresTierChoice
  } = useModelOptions({
    localConfig,
    setLocalConfig
  });

  useEffect(() => {
    if (!isOpen) return;
    refreshModels(withConfigDefaults(config));
  }, [isOpen]);

  const issues = useMemo(
    () => validateConfigDraft({ config: normalizedConfig, detectedTier: detectedProfile?.tier ?? null }),
    [normalizedConfig, detectedProfile?.tier]
  );
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const canSave = canSaveConfig(issues);

  const tabs = useMemo(() => {
    const visible: SettingsTabId[] = ['basics'];
    if (showAdvanced) {
      visible.push('model', 'runtime');
      if (isElectron) visible.push('export');
      visible.push('developer');
    }
    return visible.map((tab) => ({ id: tab, label: SETTINGS_TAB_LABELS[tab] }));
  }, [showAdvanced, isElectron]);

  const activeSection = SETTINGS_SECTIONS.find((section) => section.tab === activeTab) || SETTINGS_SECTIONS[0];
  const fields = getFieldsForTab(activeSection.tab, localConfig, isElectron);

  const handleSelectOutput = async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      setField('outputDir', path);
    }
  };

  const save = () => {
    if (!canSave) return;
    onSave(normalizedConfig);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-200/60 dark:bg-slate-900/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-ocean-800 border border-slate-200 dark:border-ocean-700 rounded-xl w-full max-w-3xl shadow-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="p-6 border-b border-slate-200 dark:border-ocean-700 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-white uppercase tracking-widest">Settings</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Basics first. Advanced settings available on demand.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-white">✕</button>
        </div>

        <div className="p-6 border-b border-slate-200 dark:border-ocean-700 flex flex-wrap items-center gap-3">
          <SettingsTabs tabs={tabs} activeTab={activeSection.tab} onChange={setActiveTab} />
          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="ml-auto px-3 py-1.5 text-[11px] font-bold uppercase rounded-lg border bg-white dark:bg-ocean-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-ocean-700"
          >
            {showAdvanced ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5">
          <SettingsSection title={activeSection.title} description={activeSection.description}>
            {fields.map((field) => (
              <FieldRenderer
                key={field.key}
                field={field}
                config={localConfig}
                projectDir={projectDir}
                isElectron={isElectron}
                availableModels={availableModels}
                isLoadingModels={isLoadingModels}
                fetchError={fetchError}
                detectedProfile={detectedProfile}
                effectiveTier={effectiveTier}
                effectiveSource={effectiveSource}
                requiresTierChoice={requiresTierChoice}
                onRefreshModels={() => refreshModels(localConfig)}
                onSelectOutput={handleSelectOutput}
                setField={setField}
              />
            ))}
          </SettingsSection>
        </div>

        <div className="p-6 border-t border-slate-200 dark:border-ocean-700 bg-slate-50/70 dark:bg-ocean-900/60">
          {warnings.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">Warnings</p>
              {warnings.map((issue, index) => (
                <p key={`${issue.field}-${index}`} className="text-[11px] text-amber-700 dark:text-amber-300">
                  {issue.message}
                </p>
              ))}
            </div>
          )}
          {errors.length > 0 && (
            <div className="mb-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-red-700 dark:text-red-300 mb-1">Save blocked</p>
              {errors.map((issue, index) => (
                <p key={`${issue.field}-${index}`} className="text-[11px] text-red-700 dark:text-red-300">
                  {issue.message}
                </p>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-5 py-2.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!canSave || requiresTierChoice}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold tracking-wide shadow-lg transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
            >
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigModal;
