import { useEffect, useMemo, useState } from 'react';
import { AppConfig } from '../../../types';
import { SettingsTabId } from './types';
import { normalizeConfigDraft, withConfigDefaults } from './validation';

interface UseConfigDraftInput {
  config: AppConfig;
  isOpen: boolean;
}

export const useConfigDraft = ({ config, isOpen }: UseConfigDraftInput) => {
  const [localConfig, setLocalConfig] = useState<AppConfig>(withConfigDefaults(config));
  const [activeTab, setActiveTab] = useState<SettingsTabId>('basics');
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLocalConfig(withConfigDefaults(config));
    setActiveTab('basics');
    setShowAdvanced(false);
  }, [isOpen, config]);

  useEffect(() => {
    if (!showAdvanced && activeTab !== 'basics') {
      setActiveTab('basics');
    }
  }, [showAdvanced, activeTab]);

  const normalizedConfig = useMemo(() => normalizeConfigDraft(localConfig), [localConfig]);

  const setField = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  };

  return {
    localConfig,
    setLocalConfig,
    setField,
    activeTab,
    setActiveTab,
    showAdvanced,
    setShowAdvanced,
    normalizedConfig,
  };
};
