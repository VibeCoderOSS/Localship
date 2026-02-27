
import React, { useState, useEffect } from 'react';
import { AppConfig } from '../types';
import { fetchAvailableModels, getModelProfile } from '../services/llmService';
import { DEFAULT_LM_STUDIO_API_URL, DEFAULT_OLLAMA_API_URL, DEFAULT_OLLAMA_CONTEXT_SIZE } from '../constants';

interface Props {
  config: AppConfig;
  onConfigReady: (newConfig: AppConfig) => void;
}

const inferProviderFromUrl = (apiUrl: string): 'lmstudio' | 'ollama' => {
  const lower = String(apiUrl || '').toLowerCase();
  if (lower.includes(':11434') || lower.includes('/api/chat') || lower.includes('/api/tags')) return 'ollama';
  return 'lmstudio';
};

const defaultEndpointForProvider = (provider: 'lmstudio' | 'ollama'): string => (
  provider === 'ollama' ? DEFAULT_OLLAMA_API_URL : DEFAULT_LM_STUDIO_API_URL
);

const ModelInitializationModal: React.FC<Props> = ({ config, onConfigReady }) => {
  const initialProvider = config.apiProvider ?? inferProviderFromUrl(config.apiUrl || '');
  const [apiProvider, setApiProvider] = useState<'lmstudio' | 'ollama'>(initialProvider);
  const [apiUrl, setApiUrl] = useState(config.apiUrl || defaultEndpointForProvider(initialProvider));
  const [ollamaContextSize, setOllamaContextSize] = useState<number>(config.ollamaContextSize ?? DEFAULT_OLLAMA_CONTEXT_SIZE);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [tierPreference, setTierPreference] = useState<'auto' | 'small' | 'large'>(config.modelTierPreference || 'auto');
  const [status, setStatus] = useState<'checking' | 'error' | 'empty' | 'ready'>('checking');
  const [errorMessage, setErrorMessage] = useState('');
  const detectedProfile = selectedModel ? getModelProfile(selectedModel) : null;
  const effectiveTier = detectedProfile
    ? (detectedProfile.tier === 'unknown' && tierPreference !== 'auto' ? tierPreference : detectedProfile.tier)
    : null;
  const effectiveSource = detectedProfile
    ? (detectedProfile.tier === 'unknown' && tierPreference !== 'auto' ? 'manual' : detectedProfile.source)
    : null;
  const requiresTierChoice = detectedProfile?.tier === 'unknown' && tierPreference === 'auto';

  const checkConnection = async (
    providerOverride: 'lmstudio' | 'ollama' = apiProvider,
    apiUrlOverride: string = apiUrl
  ) => {
    setStatus('checking');
    setErrorMessage('');
    
    try {
      const availableModels = await fetchAvailableModels(apiUrlOverride, {
        apiProvider: providerOverride,
        modelLookupMode: config.modelLookupMode ?? 'hf-cache',
        modelLookupTtlHours: config.modelLookupTtlHours ?? 168
      });
      
      if (availableModels.length === 0) {
        setStatus('empty');
        setErrorMessage("Server reachable, but no models found. Please load a model in LM Studio/Ollama.");
      } else {
        setModels(availableModels);
        // Pre-select the first model or the previously configured one if it exists
        if (availableModels.includes(config.model)) {
          setSelectedModel(config.model);
        } else {
          setSelectedModel(availableModels[0]);
        }
        setTierPreference(config.modelTierPreference || 'auto');
        setStatus('ready');
      }
    } catch (error: any) {
      setStatus('error');
      // If the error is a TypeError: Failed to fetch, it's usually CORS or Network
      const msg = error.message === 'Failed to fetch' 
        ? 'Connection Refused (Network Error). Check CORS settings and if Server is running.'
        : error.message || "Unknown Connection Error";
      setErrorMessage(msg);
    }
  };

  const selectProvider = (next: 'lmstudio' | 'ollama') => {
    setApiProvider(next);
    setModels([]);
    setSelectedModel('');
    setErrorMessage('');
    const current = String(apiUrl || '').trim();
    const shouldResetEndpoint =
      !current ||
      current === DEFAULT_LM_STUDIO_API_URL ||
      current === DEFAULT_OLLAMA_API_URL ||
      current.includes('/v1/chat/completions') ||
      current.includes('/api/chat');
    const nextUrl = shouldResetEndpoint ? defaultEndpointForProvider(next) : current;
    setApiUrl(nextUrl);
    checkConnection(next, nextUrl);
  };

  // Check on mount
  useEffect(() => {
    checkConnection();
  }, []);

  const handleConfirm = () => {
    if (selectedModel) {
      const profile = getModelProfile(selectedModel);
      if (profile.tier === 'unknown' && tierPreference === 'auto') return;
      onConfigReady({
        ...config,
        apiProvider,
        apiUrl,
        model: selectedModel,
        ollamaContextSize: Math.max(512, Math.min(262144, Math.floor(ollamaContextSize || DEFAULT_OLLAMA_CONTEXT_SIZE))),
        modelTierPreference: profile.tier === 'unknown' ? tierPreference : 'auto'
      });
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-100/80 dark:bg-slate-900/90 backdrop-blur-md transition-all">
      <div className="bg-white dark:bg-ocean-900 border border-slate-200 dark:border-ocean-700 w-full max-w-lg p-8 rounded-2xl shadow-2xl relative overflow-hidden">
        
        {/* Decorative Header */}
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-teal-400"></div>

        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 bg-slate-100 dark:bg-ocean-800 rounded-full flex items-center justify-center mb-4 shadow-inner">
             {status === 'checking' && <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full"></div>}
             {status === 'error' && <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
             {(status === 'ready' || status === 'empty') && <svg className="w-8 h-8 text-teal-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
          </div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-white tracking-tight">System Check</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-2">
            Establish connection to your local LLM to begin.
          </p>
        </div>

        <div className="space-y-6">
          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              Provider
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => selectProvider('lmstudio')}
                className={`rounded-xl border p-4 text-left transition-colors ${apiProvider === 'lmstudio' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-300 dark:border-ocean-700 bg-white dark:bg-ocean-900 hover:border-blue-300 dark:hover:border-blue-700'}`}
              >
                <p className="text-sm font-bold text-slate-800 dark:text-white">LM Studio</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">OpenAI-compatible local server</p>
              </button>
              <button
                type="button"
                onClick={() => selectProvider('ollama')}
                className={`rounded-xl border p-4 text-left transition-colors ${apiProvider === 'ollama' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-300 dark:border-ocean-700 bg-white dark:bg-ocean-900 hover:border-blue-300 dark:hover:border-blue-700'}`}
              >
                <p className="text-sm font-bold text-slate-800 dark:text-white">Ollama</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Native API with configurable num_ctx</p>
              </button>
            </div>
          </div>
          
          {/* API URL Input */}
          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              API Endpoint
            </label>
            <div className="flex gap-2">
              <input 
                type="text" 
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                className="flex-1 bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-3 text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <button 
                onClick={() => checkConnection()}
                className="px-4 py-2 bg-slate-100 dark:bg-ocean-800 hover:bg-slate-200 dark:hover:bg-ocean-700 text-slate-600 dark:text-slate-300 rounded-lg transition-colors"
                title="Retry Connection"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
          </div>

          {apiProvider === 'ollama' && (
            <div>
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                Default Context Size (num_ctx)
              </label>
              <input
                type="number"
                min={512}
                max={262144}
                step={256}
                value={ollamaContextSize}
                onChange={(e) => setOllamaContextSize(Math.max(512, Math.min(262144, Math.floor(Number(e.target.value) || DEFAULT_OLLAMA_CONTEXT_SIZE))))}
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-3 text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                Sent as <span className="font-mono">options.num_ctx</span> with each Ollama chat request.
              </p>
            </div>
          )}

          {/* Status Message Area */}
          {status === 'error' && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg p-4 flex items-start gap-3">
              <div className="flex-1">
                <h4 className="text-sm font-bold text-red-700 dark:text-red-400">Connection Failed</h4>
                <p className="text-xs text-red-600 dark:text-red-300 mt-1">{errorMessage}</p>
                <p className="text-[10px] text-red-500/80 mt-2">
                  {apiProvider === 'ollama'
                    ? 'Tip: Start Ollama with `ollama serve` and ensure at least one model is available.'
                    : 'Tip: Ensure LM Studio is running and the "Server" toggle is ON.'}
                </p>
              </div>
            </div>
          )}

          {status === 'empty' && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg p-4">
              <h4 className="text-sm font-bold text-amber-700 dark:text-amber-400">No Models Loaded</h4>
              <p className="text-xs text-amber-600 dark:text-amber-300 mt-1">{errorMessage}</p>
            </div>
          )}

          {/* Model Select - Only shows if ready */}
          {status === 'ready' && (
            <div className="animate-fade-in-up">
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                Select Model
              </label>
              <select 
                value={selectedModel}
                onChange={(e) => {
                  const nextModel = e.target.value;
                  const profile = getModelProfile(nextModel);
                  setSelectedModel(nextModel);
                  if (profile.tier !== 'unknown') {
                    setTierPreference('auto');
                  }
                }}
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-3 text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-teal-500 appearance-none text-sm font-medium"
              >
                {models.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <p className="text-[10px] text-teal-600 dark:text-teal-400 mt-2 font-bold flex items-center gap-1">
                <span className="block w-2 h-2 rounded-full bg-teal-500 animate-pulse"></span>
                Systems Online. Ready to build.
              </p>
              {detectedProfile && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-2">
                  Detected profile: <span className="font-semibold">{detectedProfile.tier.toUpperCase()}</span>
                  {detectedProfile.approxParamsB !== null ? ` (~${detectedProfile.approxParamsB.toFixed(1)}B)` : ''} via {detectedProfile.source}.
                </p>
              )}
              {effectiveTier && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                  Effective profile: <span className="font-semibold">{effectiveTier.toUpperCase()}</span> via {effectiveSource}.
                </p>
              )}
              {detectedProfile?.tier === 'unknown' && (
                <div className="mt-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-3">
                  <p className="text-[10px] text-amber-700 dark:text-amber-300 font-bold uppercase tracking-wide mb-2">
                    Unknown model size: choose behavior profile
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setTierPreference('small')}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold border ${tierPreference === 'small' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-ocean-900 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-ocean-700'}`}
                    >
                      Small-model mode
                    </button>
                    <button
                      type="button"
                      onClick={() => setTierPreference('large')}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold border ${tierPreference === 'large' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-ocean-900 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-ocean-700'}`}
                    >
                      Large-model mode
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Action Button */}
          <button
            onClick={handleConfirm}
            disabled={status !== 'ready' || !selectedModel || requiresTierChoice}
            className="w-full mt-4 py-4 bg-blue-600 hover:bg-blue-500 dark:bg-teal-500 dark:hover:bg-teal-400 text-white rounded-xl font-bold tracking-wider uppercase transition-all shadow-lg shadow-blue-500/30 dark:shadow-teal-500/30 disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed"
          >
            Enter Workspace
          </button>
          {requiresTierChoice && (
            <p className="text-[10px] text-amber-700 dark:text-amber-300 font-medium">
              Please choose small-model or large-model mode for unknown-size models.
            </p>
          )}

        </div>
      </div>
    </div>
  );
};

export default ModelInitializationModal;
