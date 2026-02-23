import {
  AppConfig,
  Message,
  ProjectFiles,
  StreamUpdate,
  ParserStage,
  ParseMode,
  ProviderFamily,
  ModelLookupMode,
  ModelProfileSource
} from '../types';
import { getFileContentsContext, validateProject } from '../utils/projectUtils';
import { lookupModelHint } from './modelRegistry';
import { getChangedFilesBetween } from './patchTransaction';
import { isAssetFilename, isEncodedAssetContent, toAssetContextPlaceholder } from '../utils/assetUtils';

export type ModelTier = 'small' | 'large' | 'unknown';
export interface ModelProfile {
  id: string;
  tier: ModelTier;
  approxParamsB: number | null;
  source: ModelProfileSource;
}

const modelProfileCache = new Map<string, ModelProfile>();
const SMALL_MODEL_THRESHOLD_B = 25;
const INTERNAL_RETRY_LIMIT = 2;
const LOW_CONFIDENCE_THRESHOLD = 0.35;
const KNOWN_MODEL_PARAM_HINTS: Array<{ pattern: RegExp; paramsB: number }> = [
  // Qwen3-Coder-Next variants are typically the 80B release name without an explicit "80B" suffix.
  { pattern: /qwen3[-_ ]coder[-_ ]next/i, paramsB: 80 }
];

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

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

const inferParamsFromModelId = (modelId: string): number | null => {
  const knownHint = KNOWN_MODEL_PARAM_HINTS.find(h => h.pattern.test(modelId));
  if (knownHint) return knownHint.paramsB;

  const lower = modelId.toLowerCase();

  const bSuffix = lower.match(/(?:^|[-_ /])(\d+(?:\.\d+)?)b(?:$|[-_ /])/);
  if (bSuffix) return toNumber(bSuffix[1]);

  const mSuffix = lower.match(/(?:^|[-_ /])(\d+(?:\.\d+)?)m(?:$|[-_ /])/);
  if (mSuffix) {
    const n = toNumber(mSuffix[1]);
    return n === null ? null : n / 1000;
  }

  return null;
};

const detectParamsFromMetadata = (modelRaw: any): number | null => {
  const candidates = [
    modelRaw?.parameter_count,
    modelRaw?.parameters,
    modelRaw?.model_size,
    modelRaw?.size,
    modelRaw?.n_params,
    modelRaw?.details?.parameter_count,
    modelRaw?.details?.parameters,
    modelRaw?.details?.model_size,
    modelRaw?.metadata?.parameter_count,
    modelRaw?.metadata?.parameters,
    modelRaw?.metadata?.model_size,
    modelRaw?.meta?.parameters
  ];

  for (const candidate of candidates) {
    const parsed = parseParamValueToB(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
};

const classifyTier = (paramsB: number | null): ModelTier => {
  if (paramsB === null) return 'unknown';
  return paramsB < SMALL_MODEL_THRESHOLD_B ? 'small' : 'large';
};

const detectProviderFamilyFromModelId = (modelId: string): Exclude<ProviderFamily, 'auto'> => {
  const lower = (modelId || '').toLowerCase();
  if (lower.includes('qwen')) return 'qwen';
  return 'generic';
};

const getEffectiveProviderFamily = (config: AppConfig): Exclude<ProviderFamily, 'auto'> => {
  if (config.providerFamily === 'qwen' || config.providerFamily === 'generic') return config.providerFamily;
  return detectProviderFamilyFromModelId(config.model);
};

const buildModelProfile = (modelId: string, modelRaw?: any): ModelProfile => {
  const fromMeta = detectParamsFromMetadata(modelRaw);
  if (fromMeta !== null) {
    return {
      id: modelId,
      tier: classifyTier(fromMeta),
      approxParamsB: fromMeta,
      source: 'metadata'
    };
  }

  const fromName = inferParamsFromModelId(modelId);
  if (fromName !== null) {
    return {
      id: modelId,
      tier: classifyTier(fromName),
      approxParamsB: fromName,
      source: 'name'
    };
  }

  return {
    id: modelId,
    tier: 'unknown',
    approxParamsB: null,
    source: 'unknown'
  };
};

export const getModelProfile = (modelId: string): ModelProfile => {
  const cached = modelProfileCache.get(modelId);
  if (cached) return cached;
  const created = buildModelProfile(modelId, { id: modelId });
  modelProfileCache.set(modelId, created);
  return created;
};

interface ModelDiscoveryOptions {
  modelLookupMode?: ModelLookupMode;
  modelLookupTtlHours?: number;
}

const applyTierPreference = (profile: ModelProfile, preference: AppConfig['modelTierPreference']): ModelProfile => {
  if (!preference || preference === 'auto') return profile;
  if (preference !== 'small' && preference !== 'large') return profile;
  return {
    ...profile,
    tier: preference,
    source: 'manual'
  };
};

const getAdaptivePromptAddendum = (profile: ModelProfile): string => {
  const canonicalExample = `Canonical valid output example:
<!-- filename: App.tsx -->
\`\`\`tsx
import React from 'react';

const App: React.FC = () => <div>Hello</div>;

export default App;
\`\`\``;

  if (profile.tier === 'small') {
    return `[ADAPTIVE MODE: SMALL MODEL]
- Keep changes minimal and deterministic.
- Prefer editing exactly one file unless wiring is explicitly broken.
- For UI/game requests, prefer replacing full App.tsx in one valid block.
- Avoid speculative multi-file refactors.
- Do not invent Tailwind utilities outside common defaults; use inline style fallback for uncommon layout needs.
- If 3D is requested, use local dependency imports only: \`import * as THREE from 'three'\`.
- Never use CDN tags or \`<script src=...>\` for three.js.
- Output must be parser-safe and concise.
- Never output <tool_call>, <toolcall>, <tool>, or <function_call> wrappers.
- First non-whitespace token must start with an HTML marker block.
${canonicalExample}`;
  }

  if (profile.tier === 'large') {
    return `[ADAPTIVE MODE: LARGE MODEL]
- You may use multi-file edits when required, but keep output parser-safe and deterministic.
- If 3D is requested, use local dependency imports only: \`import * as THREE from 'three'\`.
- Never use CDN tags or \`<script src=...>\` for three.js.
- Never output <tool_call>, <toolcall>, <tool>, or <function_call> wrappers.
- First non-whitespace token must start with an HTML marker block.
${canonicalExample}`;
  }

  return `[ADAPTIVE MODE: UNKNOWN MODEL SIZE]
- Assume constrained reasoning budget.
- Keep changes focused; prefer single-file deterministic edits when possible.
- Prioritize strict output format compliance over creativity.
- If 3D is requested, use local dependency imports only: \`import * as THREE from 'three'\`.
- Never use CDN tags or \`<script src=...>\` for three.js.
- Never output <tool_call>, <toolcall>, <tool>, or <function_call> wrappers.
- First non-whitespace token must start with an HTML marker block.
${canonicalExample}`;
};

export const fetchAvailableModels = async (
  apiUrl: string,
  options?: ModelDiscoveryOptions
): Promise<string[]> => {
  let modelsUrl = apiUrl;
  if (apiUrl.includes('/chat/completions')) modelsUrl = apiUrl.replace('/chat/completions', '/models');
  else if (apiUrl.includes('/v1')) modelsUrl = apiUrl.endsWith('/') ? `${apiUrl}models` : `${apiUrl}/models`;
  else modelsUrl = apiUrl.endsWith('/') ? `${apiUrl}v1/models` : `${apiUrl}/v1/models`;

  try {
    const response = await fetch(modelsUrl);
    if (!response.ok) throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (data.data && Array.isArray(data.data)) {
      const ids: string[] = [];
      const lookupMode = options?.modelLookupMode ?? 'hf-cache';
      const lookupTtlHours = options?.modelLookupTtlHours ?? 168;
      const lookupTasks: Array<Promise<void>> = [];

      for (const m of data.data) {
        const id = String(m?.id || '').trim();
        if (!id) continue;
        ids.push(id);

        const baseProfile = buildModelProfile(id, m);
        modelProfileCache.set(id, baseProfile);

        if (lookupMode === 'off') continue;
        if (baseProfile.source === 'metadata') continue;

        lookupTasks.push((async () => {
          const hint = await lookupModelHint(id, lookupMode, lookupTtlHours);
          if (hint.approxParamsB === null) return;
          if (hint.source === 'hf') {
            modelProfileCache.set(id, {
              id,
              tier: classifyTier(hint.approxParamsB),
              approxParamsB: hint.approxParamsB,
              source: 'hf'
            });
            return;
          }
          if (hint.source === 'fallback' && baseProfile.source === 'unknown') {
            modelProfileCache.set(id, {
              id,
              tier: classifyTier(hint.approxParamsB),
              approxParamsB: hint.approxParamsB,
              source: 'name'
            });
          }
        })());
      }

      if (lookupTasks.length > 0) {
        await Promise.allSettled(lookupTasks);
      }

      return ids;
    }
    return [];
  } catch (error) { throw error; }
};

const optimizeHistory = (history: Message[]): Message[] => {
  const userMessages = history.filter(msg => msg.role === 'user');
  return userMessages.slice(-1);
};

const MAX_FILE_CONTEXT_CHARS = 30000;
const ESSENTIAL_FILES = ['index.html', 'index.tsx', 'App.tsx', 'input.css', 'tailwind.config.js'];

const resolveFileKey = (fileRaw: string, files: ProjectFiles): string => {
  let f = fileRaw.trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/');

  if (files[f] !== undefined) return f;
  const hasSrcRoot = Object.keys(files).some(k => k.startsWith('src/'));
  if (f.startsWith('src/')) {
    const alt = f.replace(/^src\//, '');
    if (files[alt] !== undefined || !hasSrcRoot) return alt;
  }
  if (f.startsWith('./src/')) {
    const alt = f.replace(/^\.\/src\//, '');
    if (files[alt] !== undefined || !hasSrcRoot) return alt;
  }
  const lower = f.toLowerCase();
  const ci = Object.keys(files).find(k => k.toLowerCase() === lower);
  if (ci) return ci;
  return f;
};

const normalizeText = (text: string): string => {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
};

const buildFileContext = (files: ProjectFiles, prompt: string): string => {
  const allEntries = Object.entries(files).map(([name, content]) => {
    const text = String(content || '');
    const isAsset = isAssetFilename(name) || isEncodedAssetContent(text);
    return {
      name,
      content: isAsset ? toAssetContextPlaceholder(name, text) : text
    };
  });

  const totalChars = allEntries.reduce((n, entry) => n + entry.name.length + entry.content.length + 32, 0);
  if (totalChars <= MAX_FILE_CONTEXT_CHARS) {
    const contextFiles: ProjectFiles = {};
    allEntries.forEach((entry) => {
      contextFiles[entry.name] = entry.content;
    });
    return getFileContentsContext(contextFiles);
  }

  const promptLower = prompt.toLowerCase();
  const scored = allEntries.map(({ name, content }) => {
    const base = name.split('/').pop() || name;
    let score = 0;
    if (ESSENTIAL_FILES.includes(name)) score += 100;
    if (promptLower.includes(name.toLowerCase()) || promptLower.includes(base.toLowerCase())) score += 120;
    if (name.endsWith('.tsx') || name.endsWith('.ts')) score += 25;
    if (name.endsWith('.css') || name.endsWith('.html')) score += 15;
    // Prefer smaller files when scores tie to stay within budget.
    score -= Math.floor(content.length / 1500);
    return { name, content, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked: ProjectFiles = {};
  let used = 0;
  for (const entry of scored) {
    const cost = entry.name.length + entry.content.length + 32;
    if (used + cost > MAX_FILE_CONTEXT_CHARS && Object.keys(picked).length > 0) continue;
    picked[entry.name] = entry.content;
    used += cost;
  }

  const omitted = allEntries.length - Object.keys(picked).length;
  const context = getFileContentsContext(picked);
  return omitted > 0 ? `${context}\n\n[CONTEXT NOTE]\n- Omitted ${omitted} low-priority files to fit context budget.` : context;
};

const buildProjectMapWithHints = (files: ProjectFiles): string => {
  const names = Object.keys(files).sort();
  const hints = [
    '- Prefer updating App.tsx first for UI/game tasks.',
    '- Keep index.html, input.css, tailwind.config.js unchanged unless explicitly requested.',
    '- Use existing paths from the map exactly.',
  ];
  return `${names.map(f => `- ${f}`).join('\n')}\n\n[EDIT HINTS]\n${hints.join('\n')}`;
};

const normalizeToolMarkers = (text: string, warnings: string[]): string => {
  let out = text;
  const replacements: Array<{ pattern: RegExp; kind: 'patch' | 'filename' }> = [
    { pattern: /<function\s*=\s*patch:\s*([^>\s]+)\s*>/gi, kind: 'patch' },
    { pattern: /<function\s*=\s*filename:\s*([^>\s]+)\s*>/gi, kind: 'filename' },
    { pattern: /<patch:\s*([^>\n]+?)\s*>/gi, kind: 'patch' },
    { pattern: /<filename:\s*([^>\n]+?)\s*>/gi, kind: 'filename' }
  ];

  for (const r of replacements) {
    out = out.replace(r.pattern, (_m, fileRaw) => {
      const file = String(fileRaw || '').trim().replace(/["']/g, '');
      warnings.push(`AUTO_CORRECT: Converted <${r.kind}: ...> wrapper to marker for ${file}.`);
      return `<!-- ${r.kind}: ${file} -->`;
    });
  }

  // Strip tool wrappers robustly; keep inner patch text.
  out = out.replace(/<\/?\s*(tool_call|toolcall|tool|function_call)\b[^>]*>/gi, '');

  if (/<\/patch>/i.test(out)) {
    warnings.push("AUTO_CORRECT: Removed </patch> wrapper.");
    out = out.replace(/<\/patch>/gi, '');
  }
  if (/<\/function>/i.test(out)) {
    warnings.push("AUTO_CORRECT: Removed </function> wrapper.");
    out = out.replace(/<\/function>/gi, '');
  }

  return out;
};

const normalizeBrokenXmlClosings = (text: string, warnings: string[]): string => {
  let out = text;
  const tags = ['replace', 'insert_before', 'insert_after', 'delete', 'create', 'find', 'with'];
  for (const tag of tags) {
    const rx = new RegExp(`</${tag}(?=\\s|$|<)`, 'gi');
    out = out.replace(rx, `</${tag}>`);
  }
  out = out.replace(/<\/\s*$/g, '');
  if (out !== text) {
    warnings.push('AUTO_CORRECT: Repaired malformed XML closing tags in patch text.');
  }
  return out;
};

const detectThreeMisuse = (text: string): {
  hasScriptTag: boolean;
  hasCdnReference: boolean;
  hasExamplesImport: boolean;
} => {
  const hasScriptTag = /<script[^>]+src=["'][^"']*three[^"']*["'][^>]*>/i.test(text);
  const hasCdnReference =
    /(https?:\/\/[^\s"'`>]*(?:unpkg|jsdelivr|cdnjs|cdn)[^\s"'`>]*three)/i.test(text) ||
    /(https?:\/\/[^\s"'`>]*three(?:\.module)?\.js)/i.test(text);
  const hasExamplesImport = /from\s+['"]three\/examples\/jsm\//i.test(text);
  return { hasScriptTag, hasCdnReference, hasExamplesImport };
};

const decodeEscapes = (text: string): string => {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
};

const extractStringsFromJson = (value: any, out: string[]) => {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach(v => extractStringsFromJson(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(v => extractStringsFromJson(v, out));
  }
};

const decodeToolText = (toolText: string): string => {
  const trimmed = toolText.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      const parts: string[] = [];
      extractStringsFromJson(parsed, parts);
      if (parts.length > 0) return parts.join('\n');
    } catch {}
  }
  if (trimmed.includes('\\n') || trimmed.includes('\\"')) {
    return decodeEscapes(trimmed);
  }
  return toolText;
};

const extractBlockContent = (blockRaw: string): string => {
  const trimmed = blockRaw.trim();
  const fenceStart = trimmed.indexOf('```');
  if (fenceStart === -1) return trimmed;
  const afterFence = trimmed.slice(fenceStart + 3);
  const firstNewline = afterFence.indexOf('\n');
  const bodyStart = firstNewline === -1 ? fenceStart + 3 : fenceStart + 3 + firstNewline + 1;
  const fenceEnd = trimmed.indexOf('```', bodyStart);
  if (fenceEnd === -1) return trimmed.slice(bodyStart).trim();
  return trimmed.slice(bodyStart, fenceEnd).trim();
};

const stripLeadingLanguageLabel = (content: string): string => {
  const c = content.trim();
  const lines = c.split('\n');
  if (lines.length < 2) return c;
  const first = lines[0].trim().toLowerCase();
  const langLabels = new Set([
    'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'json',
    'javascript', 'typescript', 'react', 'xml'
  ]);
  if (!langLabels.has(first)) return c;
  return lines.slice(1).join('\n').trim();
};

const extractFirstWith = (text: string): string => {
  const match = /<with>([\s\S]*?)<\/with>/i.exec(text);
  if (!match) return "";
  return normalizeText(match[1]).trim();
};

const extractFirstWithLoose = (text: string): string => {
  const strict = extractFirstWith(text);
  if (strict) return strict;
  const start = text.search(/<with>/i);
  if (start === -1) return "";
  const tail = text.slice(start + 6);
  const end = tail.search(/<\/with>/i);
  const body = end === -1 ? tail : tail.slice(0, end);
  return normalizeText(body).trim();
};

const looksLikeFullFile = (content: string, filename: string): boolean => {
  const c = content.trim();
  const lower = filename.toLowerCase();
  if (c.length < 12) return false;
  if (lower.endsWith('.html')) return /<!doctype|<html/i.test(c);
  if (lower.endsWith('.css')) return /@tailwind|:root|body\s*\{/i.test(c);
  if (lower.endsWith('.json')) return c.startsWith('{') || c.startsWith('[');
  if (lower.endsWith('tailwind.config.js')) return /module\.exports\s*=/.test(c);
  if (lower.endsWith('.js') || lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return /(export\s+default|import\s+.+from|const\s+\w+|function\s+\w+|class\s+\w+|module\.exports\s*=)/.test(c);
  }
  return true;
};

const detectNamedFenceBlocks = (text: string, files: ProjectFiles): Array<{ file: string; content: string }> => {
  const out: Array<{ file: string; content: string }> = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:[#>*-]+\s*)?(?:file(?:name)?|path)\s*:?\s*([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|css|html|json|md))\s*\n\s*```[^\n]*\n([\s\S]*?)\n```/gmi,
    /(?:^|\n)\s*([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|css|html|json|md))\s*\n\s*```[^\n]*\n([\s\S]*?)\n```/gmi,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(text)) !== null) {
      const file = resolveFileKey(match[1], files);
      const content = normalizeText(match[2] || '').trim();
      if (!file || !content) continue;
      const key = `${file}::${content.length}::${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, content });
    }
  }
  return out;
};

const inferSingleFenceTarget = (text: string, files: ProjectFiles): { file: string; content: string } | null => {
  const fenceRegex = /```[^\n]*\n([\s\S]*?)\n```/gmi;
  let best = '';
  let match: RegExpExecArray | null = null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = normalizeText(match[1] || '').trim();
    if (body.length > best.length) best = body;
  }
  if (!best) return null;

  const keys = Object.keys(files);
  const has = (name: string) => keys.includes(name);
  let target = '';
  if (/<\/?html|<!doctype/i.test(best)) target = has('index.html') ? 'index.html' : '';
  else if (/ReactDOM\.createRoot/.test(best)) target = has('index.tsx') ? 'index.tsx' : '';
  else if (/@tailwind\s+base;/.test(best)) target = has('input.css') ? 'input.css' : '';
  else if (/module\.exports\s*=/.test(best)) target = has('tailwind.config.js') ? 'tailwind.config.js' : '';
  else if (/export\s+default|React\.FC|useState\(|function\s+[A-Z]/.test(best)) {
    target = has('App.tsx') ? 'App.tsx' : keys.find(k => k.endsWith('.tsx')) || '';
  }

  if (!target) return null;
  return { file: target, content: best };
};

const inferRawAppTsxFromText = (text: string, files: ProjectFiles): { file: string; content: string } | null => {
  if (!files['App.tsx']) return null;
  const normalized = normalizeText(text);

  // Common markerless output from smaller models: raw full-file content in prose stream.
  const directMatch = /(?:^|\n)(import\s+React[\s\S]*?export\s+default\s+[A-Za-z0-9_]+\s*;?)(?:\n|$)/m.exec(normalized);
  if (!directMatch) return null;

  const candidate = directMatch[1].trim();
  if (!candidate) return null;
  if (candidate.length < 120) return null;
  if (/<\/?(find|with|replace|patch|tool_call|toolcall|tool|function_call)>/i.test(candidate)) return null;
  if (!/const\s+App\b|function\s+App\b/.test(candidate)) return null;
  if (!/return\s*\(/.test(candidate)) return null;
  if (!/export\s+default\s+App\s*;?/.test(candidate)) return null;

  return { file: 'App.tsx', content: candidate };
};

type InlineOp = { type: 'replace'; find: string; with: string };

const extractInlineReplaceOps = (text: string): InlineOp[] => {
  const bodyNorm = normalizeText(text).trim().replace(/^```[a-z]*\n/i, '').replace(/```$/i, '').trim();
  const ops: InlineOp[] = [];
  const wrapperRanges: Array<{ start: number; end: number }> = [];

  const wrapperRegex = /<replace>([\s\S]*?)<\/replace>/gi;
  let wMatch: RegExpExecArray | null = null;
  while ((wMatch = wrapperRegex.exec(bodyNorm)) !== null) {
    wrapperRanges.push({ start: wMatch.index, end: wMatch.index + wMatch[0].length });
    const inner = wMatch[1];
    const findMatch = /<find>([\s\S]*?)<\/find>/i.exec(inner);
    const withMatch = /<with>([\s\S]*?)<\/with>/i.exec(inner);
    const findText = findMatch ? normalizeText(findMatch[1]).trim() : '';
    const withText = withMatch ? normalizeText(withMatch[1]).trim() : '';
    if (findText && withText) ops.push({ type: 'replace', find: findText, with: withText });
  }

  const isInsideWrapper = (idx: number) => wrapperRanges.some(r => idx >= r.start && idx < r.end);
  const siblingRegex = /<find>([\s\S]*?)<\/find>\s*<with>([\s\S]*?)<\/with>/gi;
  let sMatch: RegExpExecArray | null = null;
  while ((sMatch = siblingRegex.exec(bodyNorm)) !== null) {
    if (isInsideWrapper(sMatch.index)) continue;
    const findText = normalizeText(sMatch[1]).trim();
    const withText = normalizeText(sMatch[2]).trim();
    if (findText && withText) ops.push({ type: 'replace', find: findText, with: withText });
  }

  return ops;
};

const dedupeInlineOps = (ops: InlineOp[]): InlineOp[] => {
  const seen = new Set<string>();
  const deduped: InlineOp[] = [];
  for (const op of ops) {
    const key = `${op.type}\n${op.find}\n---\n${op.with}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(op);
  }
  return deduped;
};

const buildPatchBodyFromInlineOps = (ops: InlineOp[]): string => {
  return ops.map(op => `<replace>\n<find>\n${op.find}\n</find>\n<with>\n${op.with}\n</with>\n</replace>`).join('\n\n');
};

const applyPatches = (
  content: string,
  patchBody: string,
  isFinal: boolean,
  options?: { bestEffort?: boolean }
): { content: string, success: boolean, reason?: string, opsCount: number, appliedOps: number } => {
    const originalContent = normalizeText(content);
    // Remove code fences if the model wraps the XML in markdown
    const bodyNorm = normalizeText(patchBody).trim().replace(/^```[a-z]*\n/i, '').replace(/```$/i, '').trim();
    let newContent = originalContent;
    let allSuccessful = true;
    let failReason = "";
    let appliedOps = 0;

    type AnchorHit = { start: number; matched: string; count: number };

    const countOccurrences = (src: string, needle: string) => {
        if (!needle) return 0;
        let count = 0, idx = 0;
        while (true) {
            const next = src.indexOf(needle, idx);
            if (next === -1) break;
            count++;
            idx = next + needle.length;
        }
        return count;
    };

    const locateAnchor = (source: string, find: string): AnchorHit => {
        // Method A: Exact Match
        const exactCount = countOccurrences(source, find);
        if (exactCount === 1) return { start: source.indexOf(find), matched: find, count: 1 };
        
        // Method B: Fuzzy Line Match (Ignores leading/trailing whitespace per line)
        const norm = (t: string) => t.trim();
        const stripTrailingComment = (t: string) => t.replace(/\s*\/\/.*$/, '').trim();
        const sourceLines = source.split("\n");
        const findLines = find.split("\n").filter(l => l.trim().length > 0); // Ignore empty lines in finder
        
        if (findLines.length === 0) return { start: -1, matched: "", count: 0 };

        const hits: Array<{ lineIndex: number; matched: string }> = [];
        
        for (let i = 0; i <= sourceLines.length - findLines.length; i++) {
            let ok = true;
            for (let j = 0; j < findLines.length; j++) {
                // Compare trimmed lines
                if (norm(sourceLines[i + j]) !== norm(findLines[j])) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                // Reconstruct the actual matched block from source to preserve indentation
                const matched = sourceLines.slice(i, i + findLines.length).join("\n");
                hits.push({ lineIndex: i, matched });
            }
        }
        
        if (hits.length === 1) {
            const i = hits[0].lineIndex;
            // Calculate character index
            const start = sourceLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
            return { start, matched: hits[0].matched, count: 1 };
        }
        
        if (hits.length > 1) return { start: -1, matched: "", count: hits.length };

        // Method C: Comment-insensitive line match (ignore trailing // comments)
        const commentHits: Array<{ lineIndex: number; matched: string }> = [];
        for (let i = 0; i <= sourceLines.length - findLines.length; i++) {
          let ok = true;
          for (let j = 0; j < findLines.length; j++) {
            if (stripTrailingComment(sourceLines[i + j]) !== stripTrailingComment(findLines[j])) {
              ok = false;
              break;
            }
          }
          if (ok) {
            const matched = sourceLines.slice(i, i + findLines.length).join("\n");
            commentHits.push({ lineIndex: i, matched });
          }
        }
        if (commentHits.length === 1) {
          const i = commentHits[0].lineIndex;
          const start = sourceLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
          return { start, matched: commentHits[0].matched, count: 1 };
        }
        if (commentHits.length > 1) return { start: -1, matched: "", count: commentHits.length };
        return { start: -1, matched: "", count: 0 };
    };

    const ops: { type: string, find: string, with: string }[] = [];
    const wrapperRanges: Array<{ start: number; end: number }> = [];

    // Parse XML-style ops
    const wrapperRegex = /<(replace|insert_before|insert_after|delete|create)>([\s\S]*?)<\/\1>/gi;
    let wMatch;
    while ((wMatch = wrapperRegex.exec(bodyNorm)) !== null) {
        const type = wMatch[1].toLowerCase();
        const inner = wMatch[2];
        wrapperRanges.push({ start: wMatch.index, end: wMatch.index + wMatch[0].length });

        const findMatch = /<find>([\s\S]*?)<\/find>/i.exec(inner);
        const withMatch = /<with>([\s\S]*?)<\/with>/i.exec(inner);

        const findText = findMatch ? normalizeText(findMatch[1]) : "";
        const withText = withMatch ? normalizeText(withMatch[1]) : "";

        if (type === 'create') {
            if (withText.trim()) ops.push({ type, find: '', with: withText });
        } else if (type === 'delete') {
            if (findText.trim()) ops.push({ type, find: findText, with: "" });
        } else if (['replace', 'insert_before', 'insert_after'].includes(type)) {
            if (findText.trim() && withText.trim()) {
                ops.push({ type, find: findText, with: withText });
            }
        }
    }

    // Fallback: Parse Sibling format (common in smaller models)
    if (ops.length === 0) {
        const siblingRegex = /<find>([\s\S]*?)<\/find>\s*<with>([\s\S]*?)<\/with>/gi;
        let sMatch;
        while ((sMatch = siblingRegex.exec(bodyNorm)) !== null) {
            const findText = normalizeText(sMatch[1]);
            const withText = normalizeText(sMatch[2]);
            if (findText.trim() && withText.trim()) {
                ops.push({ type: 'replace', find: findText, with: withText });
            }
        }
    }

    // De-duplicate repeated inline operations from weaker models.
    const dedupedOps = (() => {
      const seen = new Set<string>();
      const list: { type: string; find: string; with: string }[] = [];
      for (const op of ops) {
        const key = `${op.type}\n${op.find}\n---\n${op.with}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(op);
      }
      return list;
    })();

    // Handle "Full Rewrite" / Create ops
    const createOps = dedupedOps.filter(o => o.type === 'create');
    if (createOps.length > 0) {
        const lastCreate = createOps[createOps.length - 1];
        const changed = originalContent !== lastCreate.with;
        if (!changed) {
          return isFinal
            ? { content: originalContent, success: false, reason: "Create op produced no file diff.", opsCount: 1, appliedOps: 0 }
            : { content: originalContent, success: true, reason: "", opsCount: 1, appliedOps: 0 };
        }
        return { content: lastCreate.with, success: true, reason: "", opsCount: 1, appliedOps: 1 };
    }

    if (dedupedOps.length === 0) {
        return isFinal 
            ? { content: originalContent, success: false, reason: "No valid operation segments found.", opsCount: 0, appliedOps: 0 }
            : { content: originalContent, success: true, opsCount: 0, appliedOps: 0 };
    }

    // Execute Patches
    for (const op of dedupedOps) {
        const hit = locateAnchor(newContent, op.find);
        if (hit.count > 1) {
            if (options?.bestEffort) {
              failReason = `Anchor found ${hit.count}x (ambiguous).`;
              continue;
            }
            allSuccessful = false; failReason = `Anchor found ${hit.count}x (ambiguous).`; break;
        }
        if (hit.start === -1) {
            if (options?.bestEffort) {
              failReason = "Anchor not found (check whitespace/indentation).";
              continue;
            }
            allSuccessful = false; failReason = "Anchor not found (check whitespace/indentation)."; break;
        }

        const beforeOp = newContent;
        const len = hit.matched.length;
        if (op.type === 'replace') newContent = newContent.slice(0, hit.start) + op.with + newContent.slice(hit.start + len);
        else if (op.type === 'insert_before') newContent = newContent.slice(0, hit.start) + op.with + hit.matched + newContent.slice(hit.start + len);
        else if (op.type === 'insert_after') newContent = newContent.slice(0, hit.start) + hit.matched + op.with + newContent.slice(hit.start + len);
        else if (op.type === 'delete') newContent = newContent.slice(0, hit.start) + newContent.slice(hit.start + len);
        if (newContent !== beforeOp) appliedOps += 1;
    }

    if (!allSuccessful) return { content: originalContent, success: false, reason: failReason, opsCount: dedupedOps.length, appliedOps };
    if (options?.bestEffort && appliedOps === 0) {
      return { content: originalContent, success: false, reason: failReason || "No anchors matched.", opsCount: dedupedOps.length, appliedOps };
    }
    return { content: newContent, success: true, reason: "", opsCount: dedupedOps.length, appliedOps };
};

const computeParserConfidence = (params: {
  markerCount: number;
  appliedOps: number;
  touchedFiles: string[];
  failedPatches: string[];
  warnings: string[];
  parserStage: ParserStage;
  files: ProjectFiles;
}): number => {
  const { markerCount, appliedOps, touchedFiles, failedPatches, warnings, parserStage, files } = params;
  const validation = validateProject(files);

  let score = 0.2;
  score += Math.min(markerCount, 3) * 0.15;
  if (appliedOps > 0) score += 0.2;
  if (touchedFiles.length > 0) score += 0.1;
  if (validation.valid) score += 0.2;
  if (parserStage === 'fallback') score -= 0.15;
  if (failedPatches.length > 0) score -= 0.35;
  if (warnings.some(w => w.startsWith('AUTO_INFER:'))) score -= 0.08;
  if (warnings.some(w => w.includes('markerless raw App.tsx'))) score -= 0.1;

  return clamp(score, 0, 1);
};

const parseResponse = (
    contentStream: string, 
    reasoningStream: string,
    baseFiles: ProjectFiles,
    isFinal: boolean,
    applyToFiles: boolean,
    rawModelText: string,
    rawWireText: string,
    parseMode: ParseMode
): StreamUpdate => {
  const newFiles = { ...baseFiles };
  const failedPatches: string[] = [];
  const warnings: string[] = [];
  const repairHints: string[] = [];
  const touchedFiles = new Set<string>();
  let appliedOpsTotal = 0;
  let thought: string | null = reasoningStream.trim() || null;
  const parsedParts: string[] = [];
  let parserStage: ParserStage = 'raw';
  let usedFallback = false;
  const setFileIfChanged = (fileKey: string, nextContent: string): boolean => {
    const prevContent = newFiles[fileKey] ?? '';
    if (prevContent === nextContent) return false;
    newFiles[fileKey] = nextContent;
    touchedFiles.add(fileKey);
    return true;
  };

  const normalizedText = normalizeText(contentStream);
  
  // STRIP REASONING TAGS (Support both <thinking> and <think> for R1/DeepSeek)
  let textClean = normalizedText.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, (match) => {
      // Accumulate thought if not already present from reasoning_content
      if (!thought) thought = match.replace(/<\/?(?:thinking|think)>/gi, '').trim();
      return '';
  });
  // Strip wrapper tags from parseable text (keep raw log intact)
  textClean = textClean.replace(/<\/?\s*(tool_call|toolcall|tool|function_call)\b[^>]*>/gi, '');
  textClean = textClean.replace(/<\/?(details|summary)>/gi, '');
  // Normalize non-standard tool wrappers into proper markers
  textClean = normalizeToolMarkers(textClean, warnings);
  // Repair common malformed patch endings from weaker models (e.g. </replace without ">")
  textClean = normalizeBrokenXmlClosings(textClean, warnings);
  parserStage = 'normalized';

  if (parseMode === 'stream-lite') {
    const quickMarkers = Array.from(textClean.matchAll(/<!--\s*(filename|patch):\s*([^\s>]+)\s*-->/gmi))
      .map((m) => `${String(m[1] || '').toLowerCase()}:${String(m[2] || '').trim()}`);
    return {
      rawModelText,
      rawWireText,
      cleanModelText: textClean,
      parsedBlocksText: '',
      parserStage,
      parseMode,
      droppedDebugChars: 0,
      repairHints: [],
      parserConfidence: 0.5,
      partialText: textClean,
      rawSse: rawModelText || normalizedText,
      deltaRaw: '',
      deltaRawWire: '',
      deltaClean: '',
      deltaParsed: '',
      parsedText: '',
      warnings,
      files: { ...baseFiles },
      failedPatches: [],
      thought,
      parserStats: {
        markerCount: quickMarkers.length,
        markers: quickMarkers,
        appliedOps: 0,
        touchedFiles: []
      },
      isFinal
    };
  }

  const threeMisuse = detectThreeMisuse(textClean);
  if (threeMisuse.hasScriptTag || threeMisuse.hasCdnReference || threeMisuse.hasExamplesImport) {
    repairHints.push('use_local_three_dependency');
    if (threeMisuse.hasScriptTag) {
      warnings.push("RUNTIME_RISK: Found <script src=...three...>. Use local import from 'three'.");
    }
    if (threeMisuse.hasCdnReference) {
      warnings.push("RUNTIME_RISK: Found CDN reference for three.js. Use local dependency import.");
    }
    if (threeMisuse.hasExamplesImport) {
      warnings.push("RUNTIME_RISK: three/examples/jsm/* is not supported in this environment.");
      repairHints.push('three_examples_not_supported');
    }
    if (isFinal && (threeMisuse.hasScriptTag || threeMisuse.hasCdnReference)) {
      failedPatches.push("RUNTIME_RISK: Remove CDN/script usage for three.js and use local import `from 'three'`.");
    }
    if (isFinal && threeMisuse.hasExamplesImport) {
      failedPatches.push("RUNTIME_RISK: Import path `three/examples/jsm/*` is unsupported. Use core `three` only.");
    }
  }

  // Relaxed: allow markers anywhere in the text (some models prepend text on the same line).
  const markerRegex = /<!--\s*(filename|patch):\s*([^\s>]+)\s*-->/gmi;
  
  interface Marker { kind: 'filename' | 'patch'; file: string; index: number; length: number }
  let markers: Marker[] = [];
  let m;
  while ((m = markerRegex.exec(textClean)) !== null) {
    markers.push({ kind: m[1].toLowerCase() as 'filename' | 'patch', file: m[2], index: m.index, length: m[0].length });
  }

  markers.sort((a, b) => a.index - b.index);

  const hasAnyPatchTags = /<(replace|insert_before|insert_after|delete|create)>/i.test(textClean);
  const hasCreateTag = /<create>/i.test(textClean);
  let inlinePatchAttempted = false;
  let inlinePatchApplied = false;
  let inlinePatchCandidateFile = '';
  let inlinePatchAmbiguous = false;

  if (applyToFiles) {
    if (markers.length === 0 && !isFinal) {
      // Keep intermediate streaming chunks read-only unless explicit markers are present.
      // This avoids aggressive markerless auto-corrections thrashing the workspace during generation.
    } else if (markers.length === 0) {
      const inferredBlocks = detectNamedFenceBlocks(textClean, newFiles);
      if (inferredBlocks.length > 0) {
        usedFallback = true;
        parserStage = 'fallback';
        let changedCount = 0;
        for (const block of inferredBlocks) {
          if (setFileIfChanged(block.file, block.content)) changedCount += 1;
        }
        if (changedCount > 0) {
          warnings.push(`AUTO_INFER: Applied ${changedCount} fenced filename block(s) without markers.`);
        } else if (isFinal) {
          warnings.push('NO_OP: Inferred fenced blocks matched existing content.');
        }
      } else if (hasAnyPatchTags && !hasCreateTag) {
        inlinePatchAttempted = true;
        const inlineOpsRaw = extractInlineReplaceOps(textClean);
        const inlineOps = dedupeInlineOps(inlineOpsRaw);
        const normalizedInlinePatch = inlineOps.length > 0 ? buildPatchBodyFromInlineOps(inlineOps) : textClean;
        if (inlineOpsRaw.length > inlineOps.length) {
          warnings.push(`AUTO_CORRECT: Deduplicated ${inlineOpsRaw.length - inlineOps.length} repeated inline patch op(s).`);
        }

        const candidates: Array<{
          file: string;
          result: { content: string; success: boolean; reason?: string; opsCount: number; appliedOps: number };
          score: number;
        }> = [];
        for (const [file, content] of Object.entries(newFiles)) {
          const result = applyPatches(content, normalizedInlinePatch, isFinal, { bestEffort: true });
          if (result.success && result.appliedOps > 0 && result.content !== content) {
            const score = result.appliedOps * 100 + (result.opsCount === result.appliedOps ? 1 : 0);
            candidates.push({ file, result, score });
          }
        }

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
          const topScore = candidates[0].score;
          const top = candidates.filter(c => c.score === topScore);
          if (top.length > 1) {
            inlinePatchAmbiguous = true;
            repairHints.push('ambiguous_target');
            failedPatches.push(`PROTOCOL_VIOLATION: Inline patch target ambiguous (${top.map(t => t.file).join(', ')}).`);
          } else {
            const chosen = top[0];
            inlinePatchCandidateFile = chosen.file;
            if (setFileIfChanged(chosen.file, chosen.result.content)) {
              inlinePatchApplied = true;
              usedFallback = true;
              parserStage = 'fallback';
              appliedOpsTotal += chosen.result.appliedOps;
              warnings.push(`AUTO_APPLY: Markerless inline patch applied to ${chosen.file}.`);
            } else {
              warnings.push(`NO_OP: Patch for ${chosen.file} produced no content changes.`);
            }
          }
        } else {
          const withFallback = extractFirstWithLoose(textClean);
          if (withFallback && newFiles['App.tsx'] !== undefined && looksLikeFullFile(withFallback, 'App.tsx')) {
            const changed = setFileIfChanged('App.tsx', withFallback);
            usedFallback = true;
            parserStage = 'fallback';
            if (changed) inlinePatchApplied = true;
            warnings.push(`AUTO_INFER: Applied markerless <with> fallback to App.tsx.`);
          } else {
            const rawApp = inferRawAppTsxFromText(textClean, newFiles);
            if (rawApp) {
              const changed = setFileIfChanged(rawApp.file, rawApp.content);
              usedFallback = true;
              parserStage = 'fallback';
              if (changed) inlinePatchApplied = true;
              warnings.push(`AUTO_INFER: Applied markerless raw App.tsx content.`);
            } else if (isFinal) {
              failedPatches.push("PROTOCOL_VIOLATION: Patch blocks missing markers and no matching file.");
              repairHints.push('missing_markers');
            }
          }
        }
      } else {
        const inferredSingle = inferSingleFenceTarget(textClean, newFiles);
        if (inferredSingle) {
          setFileIfChanged(inferredSingle.file, inferredSingle.content);
          usedFallback = true;
          parserStage = 'fallback';
          warnings.push(`AUTO_INFER: Applied largest fenced block to ${inferredSingle.file}.`);
        } else {
          const rawApp = inferRawAppTsxFromText(textClean, newFiles);
          if (rawApp) {
            setFileIfChanged(rawApp.file, rawApp.content);
            usedFallback = true;
            parserStage = 'fallback';
            warnings.push(`AUTO_INFER: Applied markerless raw App.tsx content.`);
          } else if (isFinal) {
            if (hasCreateTag) {
              failedPatches.push("PROTOCOL_VIOLATION: Create op found but no filename marker.");
              repairHints.push('create_without_filename_marker');
            } else {
              failedPatches.push("PROTOCOL_VIOLATION: No marker blocks found.");
              repairHints.push('no_marker_blocks');
            }
          }
        }
      }
    }

  if (markers.length > 0) {
      parserStage = 'markers';
      const seenPatchBlocks = new Set<string>();
      for (let i = 0; i < markers.length; i++) {
        const cur = markers[i];
        const next = markers[i + 1];
        const start = cur.index + cur.length;
        const end = next ? next.index : textClean.length;
        const blockRaw = textClean.slice(start, end).trim();
        const hasFence = blockRaw.includes('```');
      let cleanBlockContent = extractBlockContent(blockRaw);
      if (!hasFence) cleanBlockContent = stripLeadingLanguageLabel(cleanBlockContent);

        const fileKey = resolveFileKey(cur.file, newFiles);
        const hasPatchTags = /<(replace|insert_before|insert_after|delete|create)>/i.test(cleanBlockContent);

        if (cur.kind === 'filename') {
          // Some models incorrectly place patch ops under filename blocks.
          if (hasPatchTags) {
            warnings.push(`AUTO_CORRECT: filename block with patch ops treated as patch for ${fileKey}.`);
            const base = newFiles[fileKey] || "";
            const result = applyPatches(base, cleanBlockContent, isFinal);
            if (result.success) {
              if (setFileIfChanged(fileKey, result.content)) {
                appliedOpsTotal += result.appliedOps;
              } else {
                warnings.push(`NO_OP: Patch for ${fileKey} produced no content changes.`);
              }
            } else {
              const withFallback = extractFirstWith(cleanBlockContent);
              if (withFallback && looksLikeFullFile(withFallback, fileKey)) {
                warnings.push(`AUTO_CORRECT: patch failure; used <with> as full file for ${fileKey}.`);
                setFileIfChanged(fileKey, withFallback);
              } else if (isFinal) {
                failedPatches.push(`${fileKey}: ${result.reason}`);
                repairHints.push(`patch_failed:${fileKey}`);
              }
            }
            parsedParts.push(`<!-- ${cur.kind}: ${cur.file} -->\n${cleanBlockContent}`);
            continue;
          }

          if (!hasFence) {
            if (!looksLikeFullFile(cleanBlockContent, fileKey)) {
              if (isFinal) failedPatches.push(`PROTOCOL_VIOLATION:${fileKey}: Filename blocks must use fenced code.`);
              continue;
            }
            warnings.push(`WARN: filename block missing fence; accepted raw content for ${fileKey}.`);
          }
          setFileIfChanged(fileKey, cleanBlockContent);
          parsedParts.push(`<!-- ${cur.kind}: ${cur.file} -->\n${cleanBlockContent}`);
        } else if (cur.kind === 'patch') {
          if (hasPatchTags) {
            const patchSignature = `${fileKey}\n---\n${cleanBlockContent.trim()}`;
            if (seenPatchBlocks.has(patchSignature)) {
              warnings.push(`AUTO_CORRECT: Skipped duplicate patch block for ${fileKey}.`);
              parsedParts.push(`<!-- ${cur.kind}: ${cur.file} -->\n${cleanBlockContent}`);
              continue;
            }
            seenPatchBlocks.add(patchSignature);

            // Always apply patches from base state to avoid compounding errors in stream re-parsing
            const base = newFiles[fileKey] || "";
            const result = applyPatches(base, cleanBlockContent, isFinal);
            if (result.success) {
              if (setFileIfChanged(fileKey, result.content)) {
                appliedOpsTotal += result.appliedOps;
              } else {
                warnings.push(`NO_OP: Patch for ${fileKey} produced no content changes.`);
              }
            } else {
              const withFallback = extractFirstWith(cleanBlockContent);
              if (withFallback && looksLikeFullFile(withFallback, fileKey)) {
                setFileIfChanged(fileKey, withFallback);
              } else if (isFinal) { 
                failedPatches.push(`${fileKey}: ${result.reason}`);
                repairHints.push(`patch_failed:${fileKey}`);
              }
            }
          } else {
             warnings.push(`WARN: patch block missing ops; treated as full file for ${fileKey}.`);
             setFileIfChanged(fileKey, cleanBlockContent);
          }
          parsedParts.push(`<!-- ${cur.kind}: ${cur.file} -->\n${cleanBlockContent}`);
        }
      }
    }

    if (markers.length > 0 && isFinal && applyToFiles && appliedOpsTotal === 0 && hasAnyPatchTags) {
      // Secondary rescue path: when marker parsing degraded on the final chunk,
      // re-run inline-op extraction across the full normalized text.
      inlinePatchAttempted = true;
      const inlineOpsRaw = extractInlineReplaceOps(textClean);
      const inlineOps = dedupeInlineOps(inlineOpsRaw);
      if (inlineOpsRaw.length > inlineOps.length) {
        warnings.push(`AUTO_CORRECT: Deduplicated ${inlineOpsRaw.length - inlineOps.length} repeated inline patch op(s).`);
      }
      if (inlineOps.length > 0) {
        const normalizedInlinePatch = buildPatchBodyFromInlineOps(inlineOps);
        const candidates: Array<{
          file: string;
          result: { content: string; success: boolean; reason?: string; opsCount: number; appliedOps: number };
          score: number;
        }> = [];
        for (const [file, content] of Object.entries(newFiles)) {
          const result = applyPatches(content, normalizedInlinePatch, true, { bestEffort: true });
          if (result.success && result.appliedOps > 0 && result.content !== content) {
            const score = result.appliedOps * 100 + (result.opsCount === result.appliedOps ? 1 : 0);
            candidates.push({ file, result, score });
          }
        }

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
          const topScore = candidates[0].score;
          const top = candidates.filter(c => c.score === topScore);
          if (top.length > 1) {
            inlinePatchAmbiguous = true;
            repairHints.push('ambiguous_target');
            failedPatches.push(`PROTOCOL_VIOLATION: Inline patch target ambiguous (${top.map(t => t.file).join(', ')}).`);
          } else {
            const chosen = top[0];
            inlinePatchCandidateFile = chosen.file;
            if (setFileIfChanged(chosen.file, chosen.result.content)) {
              inlinePatchApplied = true;
              usedFallback = true;
              parserStage = 'fallback';
              appliedOpsTotal += chosen.result.appliedOps;
              warnings.push(`AUTO_RECOVER: Applied inline rescue patch to ${chosen.file} after marker parse miss.`);
            } else {
              warnings.push(`NO_OP: Inline rescue patch for ${chosen.file} produced no content changes.`);
            }
          }
        }
      }
    }
  }

  if (usedFallback && parserStage !== 'markers') parserStage = 'fallback';

  if (isFinal && inlinePatchAttempted && !inlinePatchApplied && !inlinePatchAmbiguous) {
    const suffix = inlinePatchCandidateFile ? ` (candidate: ${inlinePatchCandidateFile})` : '';
    failedPatches.push(`NO_OP: inline patch detected but no anchor matched${suffix}`);
    repairHints.push('inline_anchor_miss');
  }

  if (isFinal && applyToFiles && markers.length > 0 && hasAnyPatchTags && appliedOpsTotal === 0) {
    if (!failedPatches.includes('NO_OP: marker patch detected but produced no file diff')) {
      failedPatches.push('NO_OP: marker patch detected but produced no file diff');
    }
    repairHints.push('inline_anchor_miss');
  }

  if (isFinal && applyToFiles) {
    const coreScaffold = ['index.html', 'index.tsx', 'App.tsx'];
    const restored: string[] = [];
    coreScaffold.forEach((key) => {
      if (baseFiles[key] !== undefined && newFiles[key] === undefined) {
        newFiles[key] = baseFiles[key];
        touchedFiles.add(key);
        restored.push(key);
      }
    });
    if (restored.length > 0) {
      warnings.push(`AUTO_GUARD: Restored core scaffold file(s): ${restored.join(', ')}.`);
      repairHints.push('scaffold_guard_restore');
    }
  }

  const parserConfidence = computeParserConfidence({
    markerCount: markers.length,
    appliedOps: appliedOpsTotal,
    touchedFiles: Array.from(touchedFiles),
    failedPatches,
    warnings,
    parserStage,
    files: newFiles
  });
  if (parserConfidence < LOW_CONFIDENCE_THRESHOLD) {
    repairHints.push('low_parser_confidence');
  }

  return { 
    rawModelText,
    rawWireText,
    cleanModelText: textClean,
    parsedBlocksText: parsedParts.join('\n\n'),
    parserStage,
    parseMode,
    droppedDebugChars: 0,
    repairHints: Array.from(new Set(repairHints)),
    parserConfidence,
    partialText: textClean, 
    rawSse: rawModelText || normalizedText, 
    deltaRaw: "", 
    deltaRawWire: "",
    deltaClean: "",
    deltaParsed: "",
    parsedText: parsedParts.join('\n\n'),
    warnings,
    files: newFiles, 
    failedPatches, 
    thought, 
    isFinal,
    parserStats: {
        markerCount: markers.length,
        markers: markers.map(m => `${m.kind}:${m.file}`),
        appliedOps: appliedOpsTotal,
        touchedFiles: Array.from(touchedFiles)
    } 
  };
};

export const generateAppCode = async (
  prompt: string,
  history: Message[],
  config: AppConfig,
  currentFiles: ProjectFiles,
  onStreamUpdate: (update: StreamUpdate) => void,
  retryAttempt: number = 0,
  attemptMeta?: { attemptIndex?: number; attemptType?: 'primary' | 'retry' | 'repair' }
): Promise<StreamUpdate> => {
  const protocolFiles: ProjectFiles = {};
  const assetFileNames: string[] = [];
  Object.entries(currentFiles).forEach(([name, content]) => {
     if (name.includes('assets/vendor/') || name.includes('node_modules')) return;
     if (isAssetFilename(name) || isEncodedAssetContent(String(content || ''))) {
       assetFileNames.push(name);
       return;
     }
     protocolFiles[name] = content;
  });
  
  const baseFiles: ProjectFiles = { ...protocolFiles };
  let rawContent = "";
  let rawReasoning = "";
  let rawModelLog = "";
  let rawToolArgLog = "";
  let rawWireLog = "";
  let sawMarkers = false;
  let buffer = "";
  let shouldStop = false;
  let lastRawLen = 0;
  let lastRawWireLen = 0;
  let lastCleanLen = 0;
  let lastParsedLen = 0;
  let lastStreamEmitAt = 0;
  let pendingStreamChars = 0;
  const streamCadenceMs = Math.max(40, config.streamParseCadenceMs ?? 120);
  const streamMinEmitChars = 80;
  const streamApplyEnabled = !!config.enableLiveWorkspaceApply;

  const emitUpdate = (isFinal: boolean, applyToFiles: boolean, parseMode: ParseMode): StreamUpdate => {
    const update = parseResponse(
      rawContent,
      rawReasoning,
      baseFiles,
      isFinal,
      applyToFiles,
      rawModelLog,
      rawWireLog,
      parseMode
    );

    const rawText = rawModelLog;
    const rawWireText = rawWireLog;
    const cleanText = update.partialText || "";
    const parsedText = update.parsedText || "";
    const deltaRaw = rawText.slice(lastRawLen);
    const deltaRawWire = rawWireText.slice(lastRawWireLen);
    const deltaClean = cleanText.slice(lastCleanLen);
    const deltaParsed = parsedText.slice(lastParsedLen);
    lastRawLen = rawText.length;
    lastRawWireLen = rawWireText.length;
    lastCleanLen = cleanText.length;
    lastParsedLen = parsedText.length;

    const hasRealDiff = getChangedFilesBetween(baseFiles, update.files).length > 0;

    if (update.parserStats?.markerCount > 0) sawMarkers = true;
    onStreamUpdate({
      ...update,
      deltaRaw,
      deltaRawWire,
      deltaClean,
      deltaParsed,
      hasRealDiff,
      attemptIndex: attemptMeta?.attemptIndex,
      attemptType: attemptMeta?.attemptType,
      parseMode,
      channelStats: {
        contentChars: rawContent.length,
        reasoningChars: rawReasoning.length,
        toolArgChars: rawToolArgLog.length,
        wireChars: rawWireLog.length
      },
      isFinal
    });
    return update;
  };

  const handleDelta = (delta: any) => {
    const r = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
    const rAlt = typeof delta?.reasoning === "string" ? delta.reasoning : "";
    const c = typeof delta?.content === "string" ? delta.content : "";
    const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    const functionCall = delta?.function_call;
    let toolText = "";
    for (const call of toolCalls) {
      if (typeof call?.function?.arguments === "string") toolText += call.function.arguments;
      else if (typeof call?.arguments === "string") toolText += call.arguments;
    }
    if (!toolText && typeof functionCall?.arguments === "string") {
      toolText += functionCall.arguments;
    }
    const decodedToolText = toolText ? decodeToolText(toolText) : "";

    // Keep channels separate to avoid duplicate patch text and parser pollution.
    if (r) rawReasoning = `${rawReasoning}${r}`.slice(-200000);
    if (rAlt) rawReasoning = `${rawReasoning}${rAlt}`.slice(-200000);
    if (decodedToolText) rawToolArgLog = `${rawToolArgLog}${decodedToolText}`.slice(-500000);

    // Parse/apply channel is assistant content only.
    if (c) rawContent += c;

    // Raw model text pane should reflect model-visible assistant content only.
    if (c) rawModelLog += c;

    if (r || rAlt || c || toolText) {
        pendingStreamChars += (r.length + rAlt.length + c.length + decodedToolText.length);
        const now = Date.now();
        const shouldEmitNow =
          pendingStreamChars >= streamMinEmitChars ||
          now - lastStreamEmitAt >= streamCadenceMs;

        if (shouldEmitNow) {
          const parseMode: ParseMode = streamApplyEnabled ? 'final-full' : 'stream-lite';
          emitUpdate(false, streamApplyEnabled, parseMode);
          lastStreamEmitAt = now;
          pendingStreamChars = 0;
        }
    }
  };

  const strictContract = `[FORMAT CONTRACT]
- Return only marker blocks.
- For existing files, use <!-- patch: file --> with <replace>/<find>/<with>.
- For new files, use <!-- filename: file --> with fenced code.
- Do not output tool wrappers, prose-only responses, or markdown lists outside blocks.
- Never use CDN tags/scripts for dependencies.
- For 3D, use local dependency import: \`import * as THREE from 'three'\`.
- First non-whitespace token must start with an HTML marker block.`;

  const modelProfile = applyTierPreference(getModelProfile(config.model), config.modelTierPreference);
  const providerFamily = getEffectiveProviderFamily(config);
  if (modelProfile.tier === 'unknown' && (!config.modelTierPreference || config.modelTierPreference === 'auto')) {
    throw new Error('Unknown model size. Choose small-model or large-model mode in settings before running generation.');
  }
  const adaptiveAddendum = getAdaptivePromptAddendum(modelProfile);
  const assetSection = assetFileNames.length > 0
    ? `\n\n[ASSETS]\n${assetFileNames.sort().map((name) => `- ${name}`).join('\n')}\n- Prefer importing assets from these paths (e.g. import hero from './assets/hero.png').`
    : '';
  const fileContext = `[PROJECT MAP]\n${buildProjectMapWithHints(protocolFiles)}${assetSection}\n\n[FILE CONTENTS]\n${buildFileContext(protocolFiles, prompt)}`;
  const userContent = `${strictContract}\n\n${fileContext}\n\n[USER REQUEST]\n${prompt}`;
  const messages = [{ role: 'system', content: `${config.systemPrompt}\n\n${adaptiveAddendum}` }, ...optimizeHistory(history), { role: 'user', content: userContent }];

  try {
    const requestBody: any = {
      model: config.model,
      messages,
      stream: true
    };

    // Intentionally omit tools/tool_choice when no tool use is expected.
    if (providerFamily === 'qwen') {
      // Keep payload minimal; Qwen performs best without forced stop/tool scaffolding.
    }

    // Never force sampling knobs unless user explicitly enables override.
    if (config.samplingOverrideEnabled) {
      if (config.samplingProfile === 'strict-deterministic') {
        requestBody.temperature = 0.2;
        requestBody.top_p = 0.9;
      } else if (providerFamily === 'qwen') {
        requestBody.temperature = 1.0;
        requestBody.top_p = 0.95;
        requestBody.top_k = 40;
      }
    }

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) throw new Error(`API Error: ${response.status} ${response.statusText}`);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder("utf-8");

    if (!reader) {
       const data = await response.json();
       const rr = data.choices?.[0]?.message?.reasoning_content || "";
       const rc = data.choices?.[0]?.message?.content || "";
       rawContent = rc;
       rawReasoning = rr;
       rawModelLog = `${rc || ""}`;
       const result = emitUpdate(true, true, 'final-full');
       return result;
    } 

    const processEvents = (text: string) => {
        const events = text.split("\n\n");
        const leftovers = events.pop() || "";
        for (const evt of events) {
            const lines = evt.split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data:")) {
                    if (config.showWireDebug) {
                      rawWireLog += `${trimmed}\n`;
                    }
                    const payload = trimmed.slice(5).trim();
                    if (payload === "[DONE]") { shouldStop = true; continue; }
                    try {
                        const parsed = JSON.parse(payload);
                        const delta = parsed.choices?.[0]?.delta;
                        if (delta) handleDelta(delta);
                        else {
                            const full = parsed.choices?.[0]?.message?.content;
                            if (typeof full === "string") handleDelta({ content: full });
                        }
                    } catch (e) {}
                }
            }
        }
        return leftovers;
    };

    while (!shouldStop) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        buffer = processEvents(buffer);
    }

    if (buffer.trim()) processEvents(buffer + "\n\n");
    try { await reader.cancel(); } catch {}

    const badTokenPattern = /<\|im_start\|>|<\|im_end\|>/;
    const stripped = rawModelLog.replace(/<\|im_start\|>|<\|im_end\|>/g, '').trim();
    if (retryAttempt < INTERNAL_RETRY_LIMIT && badTokenPattern.test(rawModelLog) && stripped.length === 0) {
      const retryUpdate = parseResponse(rawContent, rawReasoning, baseFiles, false, false, rawModelLog, rawWireLog, 'final-full');
      onStreamUpdate({
        ...retryUpdate,
        warnings: [...(retryUpdate.warnings || []), "AUTO_RETRY: Special tokens detected; retrying once."],
        deltaRaw: "",
        deltaRawWire: "",
        deltaClean: "",
        deltaParsed: "",
        isFinal: false
      });
      return generateAppCode(prompt, history, config, currentFiles, onStreamUpdate, retryAttempt + 1, attemptMeta);
    }

    if (retryAttempt < INTERNAL_RETRY_LIMIT && !sawMarkers) {
      // Probe parseability using applyToFiles=true on cloned base files.
      // parseResponse clones internally, so this is safe and side-effect free.
      const retryProbe = parseResponse(rawContent, rawReasoning, baseFiles, false, true, rawModelLog, rawWireLog, 'final-full');
      const touchedCount = retryProbe.parserStats?.touchedFiles?.length || 0;
      const appliedOps = retryProbe.parserStats?.appliedOps || 0;
      const looksParseable = /(import\s+React|export\s+default|```|<replace>|<find>|<with>|<!--\s*(filename|patch):)/i.test(rawModelLog);
      const hasActionablePatch = touchedCount > 0 || appliedOps > 0;
      const hasToolWrappers = /<tool_call>|<toolcall>|<tool>|<function_call>/i.test(rawModelLog);

      if (hasToolWrappers && !hasActionablePatch) {
        onStreamUpdate({
          ...retryProbe,
          warnings: [...(retryProbe.warnings || []), "AUTO_RETRY: Tool-call wrappers detected with no actionable edits; retrying once."],
          deltaRaw: "",
          deltaRawWire: "",
          deltaClean: "",
          deltaParsed: "",
          isFinal: false
        });
        return generateAppCode(prompt, history, config, currentFiles, onStreamUpdate, retryAttempt + 1, attemptMeta);
      }

      if (looksParseable && !hasActionablePatch) {
        onStreamUpdate({
          ...retryProbe,
          warnings: [...(retryProbe.warnings || []), "AUTO_RETRY: Parseable content without actionable edits; retrying once."],
          deltaRaw: "",
          deltaRawWire: "",
          deltaClean: "",
          deltaParsed: "",
          isFinal: false
        });
        return generateAppCode(prompt, history, config, currentFiles, onStreamUpdate, retryAttempt + 1, attemptMeta);
      }
    }

    const finalUpdate = emitUpdate(true, true, 'final-full');
    return finalUpdate;
  } catch (error) { throw error; }
};
