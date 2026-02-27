import { Dispatch, SetStateAction, useMemo, useState } from 'react';
import { AppConfig } from '../../../types';
import { fetchAvailableModels, getModelProfile } from '../../../services/llmService';

interface UseModelOptionsInput {
  localConfig: AppConfig;
  setLocalConfig: Dispatch<SetStateAction<AppConfig>>;
}

export const useModelOptions = ({ localConfig, setLocalConfig }: UseModelOptionsInput) => {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refreshModels = async (cfg: AppConfig = localConfig) => {
    if (!cfg.apiUrl) return;
    setIsLoadingModels(true);
    setFetchError(null);
    try {
      const models = await fetchAvailableModels(cfg.apiUrl, {
        apiProvider: cfg.apiProvider ?? 'lmstudio',
        modelLookupMode: cfg.modelLookupMode ?? 'hf-cache',
        modelLookupTtlHours: cfg.modelLookupTtlHours ?? 168
      });

      if (!models.length) {
        setFetchError('No models found.');
        setAvailableModels([]);
        return;
      }

      setAvailableModels(models);
      if (!cfg.model || !models.includes(cfg.model)) {
        const profile = getModelProfile(models[0]);
        setLocalConfig((prev) => ({
          ...prev,
          model: models[0],
          modelTierPreference: profile.tier === 'unknown' ? (prev.modelTierPreference || 'auto') : 'auto'
        }));
      }
    } catch (error: any) {
      setFetchError(error?.message || 'Connection failed.');
    } finally {
      setIsLoadingModels(false);
    }
  };

  const detectedProfile = useMemo(
    () => (localConfig.model ? getModelProfile(localConfig.model) : null),
    [localConfig.model]
  );
  const manualTier = localConfig.modelTierPreference || 'auto';
  const effectiveTier = detectedProfile
    ? (detectedProfile.tier === 'unknown' && manualTier !== 'auto' ? manualTier : detectedProfile.tier)
    : null;
  const effectiveSource = detectedProfile
    ? (detectedProfile.tier === 'unknown' && manualTier !== 'auto' ? 'manual' : detectedProfile.source)
    : null;
  const requiresTierChoice = detectedProfile?.tier === 'unknown' && manualTier === 'auto';

  return {
    availableModels,
    isLoadingModels,
    fetchError,
    refreshModels,
    detectedProfile,
    effectiveTier,
    effectiveSource,
    requiresTierChoice
  };
};
