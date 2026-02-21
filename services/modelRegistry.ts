import { ModelLookupMode } from '../types';

export type RegistryHintSource = 'hf' | 'fallback' | 'unknown';

export interface ModelRegistryHint {
  id: string;
  approxParamsB: number | null;
  source: RegistryHintSource;
  resolvedId?: string;
  fetchedAt?: number;
}

interface CachedHint {
  approxParamsB: number | null;
  source: RegistryHintSource;
  resolvedId?: string;
  fetchedAt: number;
}

const CACHE_KEY = 'localship.modelHintCache.v1';
const REQUEST_TIMEOUT_MS = 4000;
const LOCAL_MODEL_HINTS: Array<{ pattern: RegExp; paramsB: number }> = [
  { pattern: /qwen3[-_ ]coder[-_ ]next/i, paramsB: 80 },
  { pattern: /qwen2\.5[-_ ]coder[-_ ]32b/i, paramsB: 32 },
  { pattern: /qwen2\.5[-_ ]coder[-_ ]14b/i, paramsB: 14 },
  { pattern: /qwen2\.5[-_ ]coder[-_ ]7b/i, paramsB: 7 },
  { pattern: /deepseek[-_ ]coder[-_ ]v2/i, paramsB: 236 },
  { pattern: /deepseek[-_ ]coder[-_ ]33b/i, paramsB: 33 },
  { pattern: /llama[-_ ]3\.1[-_ ]70b/i, paramsB: 70 },
  { pattern: /llama[-_ ]3\.1[-_ ]8b/i, paramsB: 8 },
  { pattern: /llama[-_ ]3[-_ ]70b/i, paramsB: 70 },
  { pattern: /llama[-_ ]3[-_ ]8b/i, paramsB: 8 }
];

const hasStorage = (): boolean => {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
};

const toNumber = (value: string): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseParamValueToB = (value: any): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000) return value / 1_000_000_000;
    return value;
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const clean = raw.replace(/,/g, '');

  const bMatch = clean.match(/^(\d+(?:\.\d+)?)\s*b$/);
  if (bMatch) return toNumber(bMatch[1]);

  const mMatch = clean.match(/^(\d+(?:\.\d+)?)\s*m$/);
  if (mMatch) {
    const n = toNumber(mMatch[1]);
    return n === null ? null : n / 1000;
  }

  const numeric = toNumber(clean);
  if (numeric !== null) {
    if (numeric > 1_000_000) return numeric / 1_000_000_000;
    return numeric;
  }

  return null;
};

const parseParamFromString = (value: string): number | null => {
  const lower = value.toLowerCase();
  const bMatch = lower.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (bMatch) return toNumber(bMatch[1]);
  const mMatch = lower.match(/(\d+(?:\.\d+)?)\s*m\b/);
  if (mMatch) {
    const n = toNumber(mMatch[1]);
    return n === null ? null : n / 1000;
  }
  return null;
};

const lookupLocalFallbackHint = (modelId: string): number | null => {
  const known = LOCAL_MODEL_HINTS.find((entry) => entry.pattern.test(modelId));
  if (known) return known.paramsB;
  return parseParamFromString(modelId);
};

const loadCache = (): Record<string, CachedHint> => {
  if (!hasStorage()) return {};
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, CachedHint>;
  } catch {
    // ignore cache read errors
  }
  return {};
};

const saveCache = (cache: Record<string, CachedHint>): void => {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore cache write errors
  }
};

const getCachedHint = (modelId: string, ttlHours: number): CachedHint | null => {
  const cache = loadCache();
  const hit = cache[modelId];
  if (!hit) return null;
  const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000;
  if (Date.now() - hit.fetchedAt > ttlMs) return null;
  return hit;
};

const setCachedHint = (modelId: string, hint: CachedHint): void => {
  const cache = loadCache();
  cache[modelId] = hint;
  saveCache(cache);
};

const unique = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

const normalizeCandidateStem = (modelId: string): string => {
  return modelId
    .replace(/[-_](mlx|gguf|awq|gptq|int\d+|fp\d+|instruct|chat|quantized)$/i, '')
    .replace(/[-_](q\d+_k_[msl]|q\d+)$/i, '');
};

const buildHfCandidates = (modelId: string): string[] => {
  const id = modelId.trim();
  const stem = normalizeCandidateStem(id);
  const candidates = [id];

  if (!id.includes('/')) {
    candidates.push(`Qwen/${id}`);
    candidates.push(`Qwen/${stem}`);
  }

  if (/qwen3[-_ ]coder[-_ ]next/i.test(id)) {
    candidates.push('Qwen/Qwen3-Coder-Next');
  }

  return unique(candidates);
};

const timedFetchJson = async (url: string): Promise<any> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const extractParamHintFromPayload = (payload: any, resolvedId: string): number | null => {
  if (!payload || typeof payload !== 'object') return null;

  const candidates: any[] = [
    payload?.cardData?.parameters,
    payload?.cardData?.model_size,
    payload?.cardData?.parameter_count,
    payload?.config?.parameters,
    payload?.config?.parameter_count,
    payload?.config?.num_parameters,
    payload?.model_size,
    payload?.parameter_count
  ];

  for (const value of candidates) {
    const parsed = parseParamValueToB(value);
    if (parsed !== null) return parsed;
  }

  if (Array.isArray(payload?.tags)) {
    for (const tag of payload.tags) {
      if (typeof tag !== 'string') continue;
      const parsed = parseParamFromString(tag);
      if (parsed !== null) return parsed;
    }
  }

  return parseParamFromString(resolvedId);
};

const fetchHfHint = async (modelId: string): Promise<ModelRegistryHint | null> => {
  const candidates = buildHfCandidates(modelId);
  for (const resolvedId of candidates) {
    const payload = await timedFetchJson(`https://huggingface.co/api/models/${encodeURIComponent(resolvedId)}`);
    if (!payload) continue;
    const approxParamsB = extractParamHintFromPayload(payload, resolvedId);
    return {
      id: modelId,
      approxParamsB,
      source: approxParamsB === null ? 'unknown' : 'hf',
      resolvedId,
      fetchedAt: Date.now()
    };
  }
  return null;
};

export const lookupModelHint = async (
  modelId: string,
  mode: ModelLookupMode,
  ttlHours: number
): Promise<ModelRegistryHint> => {
  if (!modelId) {
    return { id: modelId, approxParamsB: null, source: 'unknown' };
  }
  const fallbackParams = lookupLocalFallbackHint(modelId);
  const fallbackHint: ModelRegistryHint | null = fallbackParams === null
    ? null
    : { id: modelId, approxParamsB: fallbackParams, source: 'fallback', resolvedId: modelId, fetchedAt: Date.now() };

  const cached = getCachedHint(modelId, ttlHours);
  if (cached) {
    return {
      id: modelId,
      approxParamsB: cached.approxParamsB,
      source: cached.source,
      resolvedId: cached.resolvedId,
      fetchedAt: cached.fetchedAt
    };
  }

  if (mode === 'off') {
    return fallbackHint || { id: modelId, approxParamsB: null, source: 'unknown' };
  }

  if (mode === 'hf-cache') {
    return fallbackHint || { id: modelId, approxParamsB: null, source: 'unknown' };
  }

  const live = await fetchHfHint(modelId);
  if (!live) {
    return fallbackHint || { id: modelId, approxParamsB: null, source: 'unknown' };
  }

  setCachedHint(modelId, {
    approxParamsB: live.approxParamsB,
    source: live.source,
    resolvedId: live.resolvedId,
    fetchedAt: live.fetchedAt || Date.now()
  });

  return live;
};
