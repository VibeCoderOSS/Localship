import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Message, AppConfig, ChatState, ProjectDetails, ProjectFiles, PreviewStatus, SimpleComposerDraft, SimpleComposerPayload } from './types';
import { generateAppCode } from './services/llmService';
import { exportProject, buildProjectLocally } from './utils/exportService';
import { DEFAULT_API_URL, DEFAULT_MODEL, SYSTEM_PROMPT } from './constants';
import { runPreviewPreflight, validateProject } from './utils/projectUtils';
import PreviewFrame from './components/PreviewFrame';
import ConfigModal from './components/ConfigModal';
import BuildModal from './components/BuildModal';
import ProjectSetupModal from './components/ProjectSetupModal';
import IdeView from './components/IdeView';
import ModelInitializationModal from './components/ModelInitializationModal';
import SimpleComposer from './components/SimpleComposer';
import { buildSecondAttemptPrompt, pickBestCandidate, scoreRunCandidate, shouldTriggerSecondAttempt } from './services/runOrchestrator';
import { getChangedFilesBetween } from './services/patchTransaction';
import { composeSimplePrompt } from './utils/promptComposer';
import { arrayBufferToBase64, encodeAssetPayload, inferAssetMimeType } from './utils/assetUtils';

const INITIAL_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tailwind Local App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/index.tsx"></script>
  </body>
</html>`;

const INITIAL_INDEX_TSX = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);`;

const INITIAL_APP_TSX = `import React from 'react';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6 font-sans text-white">
      <div className="max-w-md w-full bg-slate-800 rounded-3xl p-10 shadow-2xl border border-slate-700">
        <div className="w-16 h-16 bg-blue-500 rounded-2xl mb-8 flex items-center justify-center shadow-lg shadow-blue-500/20">
          <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h1 className="text-4xl font-black mb-4 tracking-tight">Tailwind v3</h1>
        <p className="text-slate-400 text-lg leading-relaxed">
          Compiled locally, 100% offline. Ready for your next big idea.
        </p>
      </div>
    </div>
  );
};

export default App;`;

const INITIAL_TAILWIND_CONFIG = `module.exports = {
  theme: {
    extend: {},
  },
  plugins: [],
};`;

const INITIAL_INPUT_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;`;

const INITIAL_PROJECT_FILES: ProjectFiles = {
  'index.html': INITIAL_INDEX_HTML,
  'index.tsx': INITIAL_INDEX_TSX,
  'App.tsx': INITIAL_APP_TSX,
  'tailwind.config.js': INITIAL_TAILWIND_CONFIG,
  'input.css': INITIAL_INPUT_CSS
};

const isInitialStarterProject = (files: ProjectFiles): boolean => {
  const baselineKeys = Object.keys(INITIAL_PROJECT_FILES);
  const candidateKeys = Object.keys(files || {});
  if (candidateKeys.length !== baselineKeys.length) return false;
  for (const key of baselineKeys) {
    if (files[key] === undefined) return false;
    if ((files[key] || '').trim() !== (INITIAL_PROJECT_FILES[key] || '').trim()) return false;
  }
  return true;
};

const ensureSeedWorkspaceFiles = (files?: ProjectFiles | null): ProjectFiles => {
  const candidate = files || {};
  if (Object.keys(candidate).length > 0) return candidate;
  return { ...INITIAL_PROJECT_FILES };
};

const DEFAULT_AUTO_REPAIR_ATTEMPTS = 3;
const LOW_CONFIDENCE_THRESHOLD = 0.35;
const DEFAULT_DEBUG_TEXT_BUDGET = 400000;
const DEFAULT_STREAM_PARSE_CADENCE_MS = 120;
const MAX_ASSET_UPLOAD_BYTES = 12 * 1024 * 1024;

const dirnameOf = (file: string): string => {
  const parts = file.split('/');
  parts.pop();
  return parts.join('/');
};

const toRelativeSpecifier = (fromFile: string, toFile: string): string => {
  const fromParts = dirnameOf(fromFile).split('/').filter(Boolean);
  const toParts = toFile.split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i += 1;
  const up = new Array(fromParts.length - i).fill('..');
  const down = toParts.slice(i);
  const rel = [...up, ...down].join('/');
  if (!rel) return './';
  return rel.startsWith('.') ? rel : `./${rel}`;
};

const resolveLocalProjectTarget = (files: ProjectFiles, spec: string): string => {
  const normalized = spec.replace(/^local-project\//, '').replace(/^\/+/, '');
  if (files[normalized] !== undefined) return normalized;

  const exts = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json', '.html'];
  for (const ext of exts) {
    const candidate = `${normalized}${ext}`;
    if (files[candidate] !== undefined) return candidate;
  }
  for (const ext of exts) {
    const candidate = `${normalized}/index${ext}`;
    if (files[candidate] !== undefined) return candidate;
  }
  return normalized;
};

const sanitizeGeneratedFiles = (files: ProjectFiles): { files: ProjectFiles; warnings: string[]; changed: boolean } => {
  const nextFiles: ProjectFiles = { ...files };
  const warnings: string[] = [];
  let changed = false;

  for (const [name, content] of Object.entries(nextFiles)) {
    if (!/\.(tsx|ts|jsx|js)$/i.test(name)) continue;
    let updated = content;

    const rewrite = (spec: string): string => {
      if (!spec.startsWith('local-project/')) return spec;
      const target = resolveLocalProjectTarget(nextFiles, spec);
      return toRelativeSpecifier(name, target);
    };

    updated = updated.replace(/from\s+(['"])(local-project\/[^'"]+)\1/g, (_m, q, spec) => {
      const fixed = rewrite(spec);
      if (fixed !== spec) {
        warnings.push(`AUTO_FIX: Normalized import path in ${name}: ${spec} -> ${fixed}`);
        changed = true;
      }
      return `from ${q}${fixed}${q}`;
    });

    updated = updated.replace(/import\s+(['"])(local-project\/[^'"]+)\1/g, (_m, q, spec) => {
      const fixed = rewrite(spec);
      if (fixed !== spec) {
        warnings.push(`AUTO_FIX: Normalized side-effect import in ${name}: ${spec} -> ${fixed}`);
        changed = true;
      }
      return `import ${q}${fixed}${q}`;
    });

    updated = updated.replace(/import\(\s*(['"])(local-project\/[^'"]+)\1\s*\)/g, (_m, q, spec) => {
      const fixed = rewrite(spec);
      if (fixed !== spec) {
        warnings.push(`AUTO_FIX: Normalized dynamic import in ${name}: ${spec} -> ${fixed}`);
        changed = true;
      }
      return `import(${q}${fixed}${q})`;
    });

    if (name === 'index.tsx') {
      const normalized = updated.replace(/import\s+(['"])\/input\.css\1;?/g, "import './input.css';");
      if (normalized !== updated) {
        warnings.push(`AUTO_FIX: Rewrote absolute CSS import to relative in index.tsx.`);
        changed = true;
        updated = normalized;
      }
      const hasCssImport = /(^|\n)\s*import\s+['"][^'"]*input\.css['"];?/m.test(updated);
      if (!hasCssImport && nextFiles['input.css']) {
        updated = `import './input.css';\n${updated}`;
        warnings.push(`AUTO_FIX: Added missing input.css import to index.tsx.`);
        changed = true;
      }
    }

    if (updated !== content) nextFiles[name] = updated;
  }

  return { files: nextFiles, warnings: Array.from(new Set(warnings)), changed };
};

const areProjectFilesEqual = (a: ProjectFiles, b: ProjectFiles): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!(key in b)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
};

const getChangedFiles = (before: ProjectFiles, after: ProjectFiles): string[] => {
  return getChangedFilesBetween(before, after);
};

const sanitizeAssetFileName = (name: string): string => {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_');
};

const uniqueAssetPath = (existing: ProjectFiles, rawName: string): string => {
  const safe = sanitizeAssetFileName(rawName || 'asset.bin') || 'asset.bin';
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  let idx = 1;
  let candidate = `assets/${safe}`;
  while (existing[candidate] !== undefined) {
    candidate = `assets/${base}-${idx}${ext}`;
    idx += 1;
  }
  return candidate;
};

const appendWithCap = (current: string, delta: string, cap: number): { next: string; dropped: number } => {
  if (!delta) return { next: current, dropped: 0 };
  const combined = `${current}${delta}`;
  if (combined.length <= cap) return { next: combined, dropped: 0 };
  const dropped = combined.length - cap;
  return { next: combined.slice(dropped), dropped };
};

const extractInlineFindSnippet = (text: string): string => {
  const match = /<find>([\s\S]*?)<\/find>/i.exec(text || '');
  return match ? match[1].trim() : '';
};

const extractInlineCandidateFile = (failures: string[]): string => {
  for (const f of failures || []) {
    const m = /\(candidate:\s*([^)]+)\)/i.exec(f);
    if (m?.[1]) return m[1].trim();
  }
  return '';
};

const buildFileAnchorExcerpt = (fileContent: string, findSnippet: string, contextLines = 3): string => {
  if (!fileContent || !findSnippet) return '';
  const sourceLines = fileContent.split('\n');
  const needleLines = findSnippet.split('\n').map(l => l.trim()).filter(Boolean);
  if (needleLines.length === 0) return '';
  const stripComment = (s: string) => s.replace(/\s*\/\/.*$/, '').trim();

  let hit = -1;
  for (let i = 0; i <= sourceLines.length - needleLines.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (stripComment(sourceLines[i + j]) !== stripComment(needleLines[j])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      hit = i;
      break;
    }
  }
  if (hit === -1) return '';
  const start = Math.max(0, hit - contextLines);
  const end = Math.min(sourceLines.length, hit + needleLines.length + contextLines);
  return sourceLines.slice(start, end).join('\n');
};

const buildRepairFromEvidencePrompt = (params: {
  userRequest: string;
  protocolErrors: string[];
  patchErrors: string[];
  validationErrors: string[];
  runtimeErrors: string[];
  parserHints: string[];
  noEffectiveChanges: boolean;
  inlineNoOp: boolean;
}): string => {
  const lines: string[] = [];
  lines.push('REPAIR FROM EVIDENCE');
  lines.push('Use only valid marker blocks. Fix the issues below and keep successful existing behavior.');
  if (params.protocolErrors.length > 0) lines.push(`[PROTOCOL]\n${params.protocolErrors.join('\n')}`);
  if (params.patchErrors.length > 0) lines.push(`[PATCH]\n${params.patchErrors.join('\n')}`);
  if (params.validationErrors.length > 0) lines.push(`[VALIDATION]\n${params.validationErrors.join('\n')}`);
  if (params.runtimeErrors.length > 0) lines.push(`[RUNTIME]\n${params.runtimeErrors.join('\n')}`);
  if (params.parserHints.length > 0) lines.push(`[PARSER_HINTS]\n${params.parserHints.join('\n')}`);
  if (params.noEffectiveChanges) lines.push('[NO_EFFECTIVE_CHANGES]\nPrevious response produced no real file diff.');
  if (params.inlineNoOp) lines.push('[INLINE_ANCHOR_MISS]\nAnchor matching failed. Use exact current snippets.');
  lines.push('STRICT OUTPUT');
  lines.push('- Existing file edits: <!-- patch: file --> with <replace><find><with>.');
  lines.push('- New files: <!-- filename: file --> fenced source.');
  lines.push('- No prose outside marker blocks. No tool wrappers.');
  lines.push(`[ORIGINAL REQUEST]\n${params.userRequest}`);
  return lines.join('\n\n');
};

const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>('light');
  const [config, setConfig] = useState<AppConfig>({
    apiUrl: DEFAULT_API_URL,
    model: DEFAULT_MODEL,
    systemPrompt: SYSTEM_PROMPT, 
    modelTierPreference: 'auto',
    providerFamily: 'auto',
    samplingProfile: 'provider-default',
    samplingOverrideEnabled: false,
    modelLookupMode: 'hf-cache',
    modelLookupTtlHours: 168,
    qualityMode: 'adaptive-best-of-2',
    uiMode: 'simple',
    autoRepairAttempts: DEFAULT_AUTO_REPAIR_ATTEMPTS,
    previewFailureMode: 'last-good',
    enableLiveWorkspaceApply: false,
    debugTextBudgetChars: DEFAULT_DEBUG_TEXT_BUDGET,
    streamParseCadenceMs: DEFAULT_STREAM_PARSE_CADENCE_MS,
    showAdvancedDebug: false,
    showWireDebug: false,
    targetPlatform: 'mac-arm64', 
    devMode: false
  });
  
  const [isConfigured, setIsConfigured] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>({
    name: 'Tailwind App',
    author: 'Dev',
    icon: null
  });
  const [projectDir, setProjectDir] = useState<string>('');
  const [projectName, setProjectName] = useState<string>('LocalShip Project');
  const [isProjectSetupOpen, setIsProjectSetupOpen] = useState(false);
  const [setupDefaults, setSetupDefaults] = useState<{ mode: 'new' | 'import'; name: string; baseDir?: string; existingDir?: string } | null>(null);
  const [versions, setVersions] = useState<Array<{ id: string; label: string; createdAt: string; summary?: string }>>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string>('main');
  const mainFilesRef = useRef<ProjectFiles | null>(null);

  const [chatState, setChatState] = useState<ChatState>({
    messages: [],
    isLoading: false,
    statusMessage: null,
    error: null,
    files: { ...INITIAL_PROJECT_FILES },
  });

  const [thought, setThought] = useState<string | null>(null);
  const [rawOutput, setRawOutput] = useState<string>('');
  const [rawModelTextLog, setRawModelTextLog] = useState<string>('');
  const [rawWireTextLog, setRawWireTextLog] = useState<string>('');
  const [runTimelineLog, setRunTimelineLog] = useState<string>('');
  const rawOutputRef = useRef<string>('');
  const rawModelTextLogRef = useRef<string>('');
  const rawWireTextLogRef = useRef<string>('');
  const runTimelineLogRef = useRef<string>('');
  const [debugDroppedChars, setDebugDroppedChars] = useState<{ rawModel: number; parsed: number; timeline: number; wire: number }>({
    rawModel: 0,
    parsed: 0,
    timeline: 0,
    wire: 0
  });
  const [diagData, setDiagData] = useState<any>({ markerCount: 0, appliedOps: 0, failures: [], touchedFiles: [], markers: [] });
  const [currentRunDiag, setCurrentRunDiag] = useState<{ appliedOps: number; changedFiles: string[]; noOp: boolean }>({
    appliedOps: 0,
    changedFiles: [],
    noOp: false
  });
  const [testReport, setTestReport] = useState<any>(null);
  const [, setPreviewStatus] = useState<PreviewStatus | null>(null);
  const testReportRef = useRef<any>(null);
  const testReportAtRef = useRef<number>(0);
  const previewStatusRef = useRef<PreviewStatus | null>(null);
  const previewStatusAtRef = useRef<number>(0);
  const handleTestReport = useCallback((report: any) => {
    setTestReport(report);
    testReportRef.current = report;
    testReportAtRef.current = Date.now();
  }, []);
  const handlePreviewStatus = useCallback((status: PreviewStatus) => {
    setPreviewStatus(status);
    previewStatusRef.current = status;
    previewStatusAtRef.current = Date.now();
  }, []);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [runParsed, setRunParsed] = useState<string>('');
  const [runMarkers, setRunMarkers] = useState<string[]>([]);
  const [runFiles, setRunFiles] = useState<string[]>([]);
  const [runWarnings, setRunWarnings] = useState<string[]>([]);
  const [lastSummary, setLastSummary] = useState<{ files: string[]; ops: number; errors: string[]; warnings: string[] } | null>(null);
  const [runPhase, setRunPhase] = useState<'idle' | 'plan' | 'patch' | 'validate' | 'preview-check' | 'repair' | 'finalize' | 'failed'>('idle');
  const [runVisibleContent, setRunVisibleContent] = useState<string>('');
  const [runDecisionReason, setRunDecisionReason] = useState<string>('');
  const [pendingApplyCandidate, setPendingApplyCandidate] = useState<{ files: ProjectFiles; changedFiles: string[]; reason: string } | null>(null);
  const [repairFromEvidencePrompt, setRepairFromEvidencePrompt] = useState<string>('');
  const [showDevDetails, setShowDevDetails] = useState(false);
  const runSeqRef = useRef(0);
  const lastRepairSignatureRef = useRef<{ signature: string; count: number }>({ signature: '', count: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [actionMode, setActionMode] = useState<'ask' | 'build'>('build');
  const [simpleDraft, setSimpleDraft] = useState<SimpleComposerDraft>({
    goal: '',
    style: '',
    mustHave: '',
    notes: ''
  });
  const [askInput, setAskInput] = useState('');
  const [lastComposedSimplePrompt, setLastComposedSimplePrompt] = useState('');
  const prevUiModeRef = useRef<'simple' | 'advanced'>('simple');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isBuildModalOpen, setIsBuildModalOpen] = useState(false);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const hasUserPrompts = chatState.messages.some((msg) => msg.role === 'user');
  const isIterationContext = hasUserPrompts || !isInitialStarterProject(chatState.files);

  const openAssetPicker = useCallback(() => {
    assetInputRef.current?.click();
  }, []);

  const handleAssetInputChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files || []);
    if (picked.length === 0) return;

    const valid: Array<{ originalName: string; encoded: string }> = [];
    const rejected: string[] = [];

    for (const file of picked) {
      if (file.size > MAX_ASSET_UPLOAD_BYTES) {
        rejected.push(`${file.name} (too large, max ${Math.round(MAX_ASSET_UPLOAD_BYTES / (1024 * 1024))}MB)`);
        continue;
      }
      try {
        const base64 = arrayBufferToBase64(await file.arrayBuffer());
        const encoded = encodeAssetPayload({
          base64,
          mime: file.type || inferAssetMimeType(file.name),
          name: file.name,
          size: file.size
        });
        valid.push({ originalName: file.name, encoded });
      } catch {
        rejected.push(`${file.name} (read failed)`);
      }
    }

    if (valid.length > 0) {
      setChatState((prev) => {
        const nextFiles: ProjectFiles = { ...prev.files };
        valid.forEach((asset) => {
          const targetPath = uniqueAssetPath(nextFiles, asset.originalName);
          nextFiles[targetPath] = asset.encoded;
        });
        const status = rejected.length > 0
          ? `Added ${valid.length} asset(s). Skipped ${rejected.length}.`
          : `Added ${valid.length} asset(s).`;
        return { ...prev, files: nextFiles, statusMessage: status };
      });
    } else if (rejected.length > 0) {
      setChatState((prev) => ({ ...prev, statusMessage: `No assets added. Skipped ${rejected.length} file(s).` }));
    }

    event.target.value = '';
  }, []);

  // Monotonic Session Tracking
  const totalMarkers = useRef(0);
  const totalOps = useRef(0);
  const failuresRef = useRef<string[]>([]);
  const markersTimelineRef = useRef<string[]>([]);
  const touchedFilesRef = useRef<Set<string>>(new Set());

  const makeExcerpt = (text: string, max = 1200) => {
    const clean = text?.trim() || '';
    if (!clean) return '';
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max)}\n... [truncated]`;
  };

  const appendDebugBuffer = useCallback((kind: 'rawModel' | 'parsed' | 'timeline' | 'wire', delta: string) => {
    if (!delta) return;
    const cap = Math.max(20000, config.debugTextBudgetChars ?? DEFAULT_DEBUG_TEXT_BUDGET);
    let next = '';
    let dropped = 0;
    if (kind === 'rawModel') {
      const result = appendWithCap(rawModelTextLogRef.current, delta, cap);
      next = result.next;
      dropped = result.dropped;
      rawModelTextLogRef.current = next;
      setRawModelTextLog(next);
    } else if (kind === 'parsed') {
      const result = appendWithCap(rawOutputRef.current, delta, cap);
      next = result.next;
      dropped = result.dropped;
      rawOutputRef.current = next;
      setRawOutput(next);
    } else if (kind === 'timeline') {
      const result = appendWithCap(runTimelineLogRef.current, delta, cap);
      next = result.next;
      dropped = result.dropped;
      runTimelineLogRef.current = next;
      setRunTimelineLog(next);
    } else {
      const result = appendWithCap(rawWireTextLogRef.current, delta, cap);
      next = result.next;
      dropped = result.dropped;
      rawWireTextLogRef.current = next;
      setRawWireTextLog(next);
    }
    if (dropped > 0) {
      setDebugDroppedChars(prev => ({
        ...prev,
        [kind]: prev[kind] + dropped
      }));
    }
  }, [config.debugTextBudgetChars]);

  const resetDebugBuffers = useCallback(() => {
    rawOutputRef.current = '';
    rawModelTextLogRef.current = '';
    rawWireTextLogRef.current = '';
    runTimelineLogRef.current = '';
    setRawOutput('');
    setRawModelTextLog('');
    setRawWireTextLog('');
    setRunTimelineLog('');
    setDebugDroppedChars({ rawModel: 0, parsed: 0, timeline: 0, wire: 0 });
  }, []);

  const formatMarker = (marker: string) => {
    const [kind, file] = marker.split(':');
    if (!file) return marker;
    return `${kind.toUpperCase()} ${file}`;
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const raw = localStorage.getItem('localship.appConfig');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      setConfig(prev => ({
        ...prev,
        ...parsed,
        providerFamily: parsed.providerFamily ?? prev.providerFamily ?? 'auto',
        samplingProfile: parsed.samplingProfile ?? prev.samplingProfile ?? 'provider-default',
        samplingOverrideEnabled: parsed.samplingOverrideEnabled ?? prev.samplingOverrideEnabled ?? false,
        modelLookupMode: parsed.modelLookupMode ?? prev.modelLookupMode ?? 'hf-cache',
        modelLookupTtlHours: parsed.modelLookupTtlHours ?? prev.modelLookupTtlHours ?? 168,
        qualityMode: parsed.qualityMode ?? prev.qualityMode ?? 'adaptive-best-of-2',
        uiMode: parsed.uiMode ?? prev.uiMode ?? 'simple',
        autoRepairAttempts: parsed.autoRepairAttempts ?? prev.autoRepairAttempts ?? DEFAULT_AUTO_REPAIR_ATTEMPTS,
        previewFailureMode: parsed.previewFailureMode ?? prev.previewFailureMode ?? 'last-good',
        enableLiveWorkspaceApply: parsed.enableLiveWorkspaceApply ?? prev.enableLiveWorkspaceApply ?? false,
        debugTextBudgetChars: parsed.debugTextBudgetChars ?? prev.debugTextBudgetChars ?? DEFAULT_DEBUG_TEXT_BUDGET,
        streamParseCadenceMs: parsed.streamParseCadenceMs ?? prev.streamParseCadenceMs ?? DEFAULT_STREAM_PARSE_CADENCE_MS,
        showAdvancedDebug: parsed.showAdvancedDebug ?? prev.showAdvancedDebug ?? false,
        showWireDebug: parsed.showWireDebug ?? prev.showWireDebug ?? false
      }));
    } catch {
      // ignore invalid local config cache
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('localship.appConfig', JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    if ((!config.devMode || !config.showAdvancedDebug) && isDebugOpen) {
      setIsDebugOpen(false);
    }
  }, [config.devMode, config.showAdvancedDebug, isDebugOpen]);

  useEffect(() => {
    if (!config.devMode && viewMode === 'code') {
      setViewMode('preview');
    }
  }, [config.devMode, viewMode]);

  useEffect(() => {
    if ((config.uiMode || 'simple') === 'simple' && viewMode === 'code') {
      setViewMode('preview');
    }
  }, [config.uiMode, viewMode]);

  useEffect(() => {
    const currentUiMode = (config.uiMode || 'simple') as 'simple' | 'advanced';
    const previous = prevUiModeRef.current;
    if (previous === 'simple' && currentUiMode === 'advanced') {
      const fallbackFromDraft = actionMode === 'ask'
        ? composeSimplePrompt({
            mode: 'ask',
            goal: askInput
          })
        : composeSimplePrompt({
            mode: isIterationContext ? 'iterate' : 'build',
            goal: simpleDraft.goal || '',
            style: simpleDraft.style || '',
            mustHave: simpleDraft.mustHave || '',
            notes: simpleDraft.notes || ''
          });
      const nextPrompt = (lastComposedSimplePrompt || fallbackFromDraft).trim();
      if (nextPrompt) {
        setInput(nextPrompt);
      }
    }
    prevUiModeRef.current = currentUiMode;
  }, [config.uiMode, lastComposedSimplePrompt, actionMode, simpleDraft, askInput, isIterationContext]);

  useEffect(() => {
    if (!window.electronAPI) return;
    const savedDir = localStorage.getItem('localship.projectDir') || '';
    const savedName = localStorage.getItem('localship.projectName') || 'LocalShip Project';
    if (!savedDir) {
      setProjectName(savedName);
      setSetupDefaults({ mode: 'new', name: savedName });
      setIsProjectSetupOpen(true);
      return;
    }
    window.electronAPI.validateProjectDir({ projectDir: savedDir }).then((res) => {
      if (!res?.exists) {
        localStorage.removeItem('localship.projectDir');
        setProjectName(savedName);
        setSetupDefaults({ mode: 'new', name: savedName });
        setIsProjectSetupOpen(true);
        return;
      }
      setProjectName(savedName);
      setSetupDefaults({ mode: 'import', name: savedName, existingDir: savedDir });
      setIsProjectSetupOpen(true);
    });
  }, []);

  useEffect(() => {
    if (selectedVersionId === 'main') {
      mainFilesRef.current = chatState.files;
    }
  }, [chatState.files, selectedVersionId]);

  const syncTimerRef = useRef<number | null>(null);
  const lastSyncedRef = useRef<string>('');
  const persistGuardRef = useRef<string>('');

  useEffect(() => {
    if (!window.electronAPI) return;
    if (!projectDir) return;
    if (selectedVersionId !== 'main') return;
    const persistPreflight = runPreviewPreflight(chatState.files);
    if (!persistPreflight.ok) {
      const signature = persistPreflight.fatalErrors.join('|');
      if (persistGuardRef.current !== signature) {
        persistGuardRef.current = signature;
        setRunWarnings(prev => Array.from(new Set([
          ...prev,
          'workspace_persist_skipped_unsafe_shape',
          ...persistPreflight.fatalErrors.map(e => `persist_guard: ${e}`)
        ])));
      }
      return;
    }

    const snapshot = JSON.stringify(chatState.files || {});
    if (snapshot === lastSyncedRef.current) return;
    persistGuardRef.current = '';

    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      window.electronAPI?.saveWorkspace({ projectDir, files: chatState.files }).then((res) => {
        if (res?.success) lastSyncedRef.current = snapshot;
      }).catch(() => {});
    }, 600);

    return () => {
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    };
  }, [chatState.files, projectDir, selectedVersionId]);

  const handleSend = async (
    manualInput?: string,
    isRepairCall = false,
    repairAttempt = 0,
    baseFiles?: ProjectFiles,
    rollbackFiles?: ProjectFiles,
    attemptIndex = 1,
    attemptType: 'primary' | 'retry' | 'repair' = isRepairCall ? 'repair' : 'primary',
    applyToWorkspace = true,
    liveApplyDuringStream = config.enableLiveWorkspaceApply ?? false
  ) => {
    if (selectedVersionId !== 'main') {
      setSelectedVersionId('main');
      if (mainFilesRef.current) {
        setChatState(prev => ({ ...prev, files: mainFilesRef.current || prev.files }));
      }
    }

    const isUpdateCall = chatState.messages.some(m => m.role === 'assistant') || isRepairCall;
    const protocolPrefix = isUpdateCall ? `UPDATE_MODE_ACTIVE:
- For EXISTING files in PROJECT MAP, prefer <!-- patch: ... -->.
- If patch ops are not possible, you may output full file content using <!-- filename: ... -->.
- Never output <tool_call>, <toolcall>, <tool>, <function_call>, or any tool syntax. If you feel you must, rewrite as plain text without any tool wrapper tags.
- Patch ops MUST follow this format:
  <replace><find>snippet</find><with>new code</with></replace>
\n\n` : '';

    const rawPromptText = (manualInput || input).trim();
    const sourceFiles = ensureSeedWorkspaceFiles(baseFiles || chatState.files);
    const rollbackBaseline = rollbackFiles || sourceFiles;
    const runStartedAt = Date.now();
    let lastActionableFiles = sourceFiles;
    let hadActionableStreamChange = false;

    if (!rawPromptText || chatState.isLoading) return;
    if (!isConfigured) {
      const msg = "Please configure your model connection before sending requests.";
      setChatState(prev => ({
        ...prev,
        error: msg,
        statusMessage: "Not configured",
        messages: [...prev.messages, { role: 'assistant', content: msg }]
      }));
      return;
    }

    if (!baseFiles && Object.keys(chatState.files || {}).length === 0) {
      setChatState(prev => ({ ...prev, files: sourceFiles }));
    }

    const shouldAppendUser = !isRepairCall && attemptIndex === 1;
    const userMsg: Message = { role: 'user', content: rawPromptText };
    const uiHistory = shouldAppendUser ? [...chatState.messages, userMsg] : chatState.messages;

    if (!isRepairCall && attemptIndex === 1) {
      runSeqRef.current += 1;
      setRunPhase('plan');
      setRunVisibleContent('');
      setRunDecisionReason('');
      setPendingApplyCandidate(null);
      setRepairFromEvidencePrompt('');
      resetDebugBuffers();
      lastRepairSignatureRef.current = { signature: '', count: 0 };
      setCurrentRunDiag({ appliedOps: 0, changedFiles: [], noOp: false });
    } else if (isRepairCall) {
      setRunPhase('repair');
    } else {
      setRunPhase('plan');
    }

    setChatState(prev => ({
      ...prev,
      messages: uiHistory,
      isLoading: true,
      statusMessage: isRepairCall ? "🛠️ REPAIRING..." : (attemptType === 'retry' ? "Retrying..." : "Architecting...")
    }));

    const turnLabel = isRepairCall ? 'REPAIR' : (attemptType === 'retry' ? 'RETRY' : 'REQUEST');
    const turnHeader = `\n\n>>> TURN ${Math.floor(chatState.messages.length / 2) + 1} (${turnLabel}#${attemptIndex}): ${rawPromptText.slice(0, 40)}...\n`;
    appendDebugBuffer('timeline', turnHeader);

    if (!isRepairCall && attemptIndex === 1) {
      setThought(null);
      setInput('');
      setRunParsed('');
      setRunMarkers([]);
      setRunFiles([]);
      setRunWarnings([]);
      setLastSummary(null);
      setShowDevDetails(false);
      setPreviewStatus(null);
      previewStatusRef.current = null;
      previewStatusAtRef.current = 0;
      setTestReport(null);
      testReportRef.current = null;
      testReportAtRef.current = 0;
    }
    if (!isRepairCall && attemptType === 'retry') {
      setPreviewStatus(null);
      previewStatusRef.current = null;
      previewStatusAtRef.current = 0;
      setTestReport(null);
      testReportRef.current = null;
      testReportAtRef.current = 0;
    }

    try {
      const result = await generateAppCode(
        protocolPrefix + rawPromptText,
        chatState.messages,
        config,
        sourceFiles,
        (update) => {
          if (update.deltaRaw) appendDebugBuffer('rawModel', update.deltaRaw);
          if (update.deltaRawWire && config.showWireDebug) appendDebugBuffer('wire', update.deltaRawWire);
          if (update.deltaParsed) {
            appendDebugBuffer('parsed', update.deltaParsed);
            setRunParsed(prev => appendWithCap(prev, update.deltaParsed, Math.max(10000, config.debugTextBudgetChars ?? DEFAULT_DEBUG_TEXT_BUDGET)).next);
          }
          if (!update.isFinal) {
            const hasPatchSignals =
              (update.parserStats?.markerCount || 0) > 0 ||
              (update.parserStats?.appliedOps || 0) > 0 ||
              (update.parserStats?.touchedFiles?.length || 0) > 0;
            setRunPhase(prev => (prev === 'repair' ? prev : (hasPatchSignals ? 'patch' : 'plan')));
          }
          const visibleCandidate =
            (update.parsedBlocksText && update.parsedBlocksText.trim()) ||
            (update.cleanModelText && update.cleanModelText.trim()) ||
            (update.thought && update.thought.trim()) ||
            '';
          if (visibleCandidate) {
            setRunVisibleContent(makeExcerpt(visibleCandidate, 900));
          }
          if (update.parserStats?.markers) setRunMarkers(update.parserStats.markers);
          if (update.parserStats?.touchedFiles) setRunFiles(update.parserStats.touchedFiles);
          if (update.warnings) setRunWarnings(update.warnings);
          if (update.hasRealDiff || (update.parserStats?.appliedOps || 0) > 0 || (update.parserStats?.touchedFiles?.length || 0) > 0) {
            hadActionableStreamChange = true;
            lastActionableFiles = update.files;
          }
          setCurrentRunDiag({
            appliedOps: update.parserStats?.appliedOps || 0,
            changedFiles: update.parserStats?.touchedFiles || [],
            noOp: (update.failedPatches || []).some(f => f.startsWith('NO_OP: inline patch')) || (update.repairHints || []).includes('inline_anchor_miss')
          });

          const markerIncrement = update.isFinal ? update.parserStats.markerCount : 0;
          const opsIncrement = update.isFinal ? update.parserStats.appliedOps : 0;
          const touchedIncrement = update.isFinal ? update.parserStats.touchedFiles : [];
          const markerTimelineIncrement = update.isFinal ? update.parserStats.markers : [];
          setDiagData({
            markerCount: totalMarkers.current + markerIncrement,
            appliedOps: totalOps.current + opsIncrement,
            failures: Array.from(new Set([...failuresRef.current, ...(update.isFinal ? update.failedPatches : [])])),
            touchedFiles: Array.from(new Set([...Array.from(touchedFilesRef.current), ...touchedIncrement])),
            markers: [...markersTimelineRef.current, ...markerTimelineIncrement]
          });

          setChatState(prev => ({
            ...prev,
            files: applyToWorkspace && liveApplyDuringStream
              ? (areProjectFilesEqual(prev.files, update.files) ? prev.files : update.files)
              : prev.files,
            statusMessage: update.thought ? "Thinking..." : "Generating..."
          }));
          if (update.thought) setThought(makeExcerpt(update.thought, 12000));

          if (update.isFinal) {
            update.failedPatches.forEach(f => { if (!failuresRef.current.includes(f)) failuresRef.current.push(f); });
            totalMarkers.current += update.parserStats.markerCount;
            totalOps.current += update.parserStats.appliedOps;
            update.parserStats.touchedFiles.forEach(f => touchedFilesRef.current.add(f));
            markersTimelineRef.current.push(...update.parserStats.markers);
          }
        },
        0,
        { attemptIndex, attemptType }
      );

      if (!applyToWorkspace) {
        const advisory = makeExcerpt(
          result.cleanModelText || result.rawModelText || result.parsedBlocksText || result.partialText || 'No response body.',
          1400
        );
        setChatState(prev => ({
          ...prev,
          files: sourceFiles,
          isLoading: false,
          statusMessage: null,
          messages: [...uiHistory, { role: 'assistant', content: advisory || 'Advisory response generated.' }]
        }));
        setThought(null);
        setRunDecisionReason('Ask mode: no workspace mutations were applied.');
        setRunPhase('finalize');
        setRepairFromEvidencePrompt('');
        setLastSummary({ files: [], ops: 0, errors: [], warnings: ['ASK_MODE: Output was not applied to files.'] });
        return;
      }

      const baselineValidation = validateProject(sourceFiles);
      const baselineErrorSet = new Set(baselineValidation.errors);
      const currentPreviewStatus =
        previewStatusAtRef.current >= runStartedAt ? previewStatusRef.current : null;
      const currentTestReport =
        testReportAtRef.current >= runStartedAt ? testReportRef.current : null;
      const runtimeErrors: string[] = [];
      if (currentPreviewStatus && !currentPreviewStatus.candidateOk && Array.isArray(currentPreviewStatus.errors)) {
        runtimeErrors.push(...currentPreviewStatus.errors.map(e => `PREVIEW: ${e}`));
      }
      if (currentTestReport?.ok === false && Array.isArray(currentTestReport.errors)) {
        runtimeErrors.push(...currentTestReport.errors.map((e: string) => `SMOKE: ${e}`));
      }
      const runtimeOk = runtimeErrors.length === 0;

      const evaluateCandidate = (
        label: 'final' | 'stream' | 'baseline',
        files: ProjectFiles,
        appliedOps: number,
        hardFailureCount: number
      ) => {
        const sanitized = sanitizeGeneratedFiles(files);
        const changedFiles = getChangedFiles(sourceFiles, sanitized.files);
        const validation = validateProject(sanitized.files);
        const newValidationErrors = validation.errors.filter(err => !baselineErrorSet.has(err));
        const previewPreflight = runPreviewPreflight(sanitized.files);
        const structuralFatalCount = previewPreflight.ok ? 0 : previewPreflight.fatalErrors.length;
        const metrics = scoreRunCandidate(
          newValidationErrors.length,
          runtimeOk,
          changedFiles.length,
          appliedOps,
          hardFailureCount + structuralFatalCount
        );
        return {
          label,
          files: sanitized.files,
          warnings: Array.from(new Set([
            ...sanitized.warnings,
            ...previewPreflight.warnings.map(w => `preview_preflight: ${w}`)
          ])),
          changed: sanitized.changed,
          changedFiles,
          validation,
          newValidationErrors,
          previewPreflight,
          metrics
        };
      };

      const candidatePool = [
        evaluateCandidate(
          'final',
          result.files,
          result.parserStats?.appliedOps || 0,
          result.failedPatches.length
        )
      ];
      if (hadActionableStreamChange) {
        candidatePool.push(evaluateCandidate('stream', lastActionableFiles, 0, 0));
      }
      candidatePool.push(evaluateCandidate('baseline', rollbackBaseline, 0, 0));

      const changedWithoutRegression = candidatePool
        .filter(c => c.changedFiles.length > 0 && c.newValidationErrors.length === 0);
      const preflightSafe = (changedWithoutRegression.length > 0 ? changedWithoutRegression : candidatePool)
        .filter(c => c.previewPreflight.ok);
      const scoredPool = (preflightSafe.length > 0 ? preflightSafe : (changedWithoutRegression.length > 0 ? changedWithoutRegression : candidatePool));
      const ranked = scoredPool.map(c => ({ id: c.label, metrics: c.metrics }));
      const picked = pickBestCandidate(ranked);
      const selectedCandidate = scoredPool.find(c => c.label === picked?.id) || scoredPool[0];
      const sortedByScore = [...scoredPool].sort((a, b) => b.metrics.score - a.metrics.score);
      const runnerUp = sortedByScore[1];

      setPendingApplyCandidate(null);
      if (
        runnerUp &&
        Math.abs(sortedByScore[0].metrics.score - runnerUp.metrics.score) <= 30 &&
        runnerUp.changedFiles.length > 0 &&
        runnerUp.newValidationErrors.length === 0 &&
        runnerUp.label !== selectedCandidate.label
      ) {
        setPendingApplyCandidate({
          files: runnerUp.files,
          changedFiles: runnerUp.changedFiles,
          reason: `Alternative ${runnerUp.label} candidate scored close to selected candidate.`
        });
      }

      const verifiedFiles = selectedCandidate.files;
      const mergedWarnings = Array.from(new Set([
        ...(result.warnings || []),
        ...(selectedCandidate.warnings || [])
      ]));
      const decisionReason = selectedCandidate.label === 'final'
        ? 'Selected final parse candidate.'
        : `Selected ${selectedCandidate.label} candidate due to stronger score and validation outcome.`;
      setRunDecisionReason(decisionReason);

      if (selectedCandidate.label !== 'final') {
        mergedWarnings.push(`AUTO_RECOVER: Selected ${selectedCandidate.label} candidate due to better validation/change quality.`);
      }
      if (selectedCandidate.changed) {
        setChatState(prev => ({ ...prev, files: verifiedFiles }));
      }
      if (selectedCandidate.warnings.length > 0) {
        setRunWarnings(prev => Array.from(new Set([...prev, ...selectedCandidate.warnings])));
      }

      setRunPhase(prev => (prev === 'repair' ? 'repair' : 'validate'));
      const validation = validateProject(verifiedFiles);
      setRunPhase(prev => (prev === 'repair' ? 'repair' : 'preview-check'));

      const violations = result.failedPatches.filter(f => f.startsWith('PROTOCOL_VIOLATION:'));
      const technicals = result.failedPatches.filter(f => !f.startsWith('PROTOCOL_VIOLATION:'));
      const parserHints = Array.from(new Set(result.repairHints || []));
      const parserConfidence = typeof result.parserConfidence === 'number' ? result.parserConfidence : 1;
      const lowConfidence = parserConfidence < LOW_CONFIDENCE_THRESHOLD;
      const inlineNoOp = parserHints.includes('inline_anchor_miss') || result.failedPatches.some(f => f.startsWith('NO_OP: inline patch'));
      const touchedFilesCount = result.parserStats?.touchedFiles?.length || 0;
      const effectiveChangedFiles = getChangedFiles(sourceFiles, verifiedFiles);
      const hasUsableEdits = effectiveChangedFiles.length > 0 && validation.valid;
      const attemptedEdit = (result.parserStats?.markerCount || 0) > 0 || (result.parsedBlocksText || '').trim().length > 0;
      const noEffectiveChanges = attemptedEdit && effectiveChangedFiles.length === 0;
      const autoRepairableViolations = violations.filter(v =>
        v.includes('No marker blocks found') ||
        v.includes('Filename blocks must use fenced code') ||
        v.includes('Patch blocks missing markers')
      );
      const maxRepairAttempts = config.autoRepairAttempts ?? DEFAULT_AUTO_REPAIR_ATTEMPTS;
      const hasHardIssues =
        !validation.valid ||
        technicals.length > 0 ||
        autoRepairableViolations.length > 0 ||
        inlineNoOp ||
        noEffectiveChanges;
      const hasRuntimeIssues = runtimeErrors.length > 0;
      const hasIssues = hasHardIssues || hasRuntimeIssues;
      const mergedWarningsFinal = !hasHardIssues && lowConfidence
        ? Array.from(new Set([
            ...mergedWarnings,
            `LOW_CONFIDENCE: parserConfidence=${parserConfidence.toFixed(2)} stage=${result.parserStage}`
          ]))
        : mergedWarnings;

      const retryDecision = shouldTriggerSecondAttempt({
        qualityMode: config.qualityMode || 'adaptive-best-of-2',
        isRepairCall,
        attemptIndex,
        hasHardIssues,
        hasRuntimeIssues,
        noEffectiveChanges,
        inlineNoOp
      });
      if (retryDecision.shouldRetry) {
        const retryPrompt = buildSecondAttemptPrompt({
          basePrompt: rawPromptText,
          protocolErrors: autoRepairableViolations,
          patchErrors: technicals,
          validationErrors: validation.errors,
          runtimeErrors,
          parserHints,
          noEffectiveChanges,
          inlineNoOp
        });
        setRunDecisionReason(`Running second attempt (${retryDecision.reason}).`);
        return handleSend(
          retryPrompt,
          false,
          repairAttempt,
          sourceFiles,
          verifiedFiles,
          attemptIndex + 1,
          'retry',
          true,
          liveApplyDuringStream
        );
      }

      let shouldAutoRepair = hasHardIssues && !hasUsableEdits && repairAttempt < maxRepairAttempts;
      let repeatedRepairSignature = false;

      if (shouldAutoRepair) {
        const repairSignature = [
          `v:${autoRepairableViolations.join('|')}`,
          `t:${technicals.join('|')}`,
          `x:${validation.errors.join('|')}`,
          `r:${runtimeErrors.join('|')}`,
          `h:${parserHints.join('|')}`,
          `s:${result.parserStage}`,
          `tc:${touchedFilesCount}`
        ].join('||');
        if (lastRepairSignatureRef.current.signature === repairSignature) {
          lastRepairSignatureRef.current.count += 1;
        } else {
          lastRepairSignatureRef.current = { signature: repairSignature, count: 1 };
        }
        if (lastRepairSignatureRef.current.count >= 2) {
          repeatedRepairSignature = true;
          shouldAutoRepair = false;
        }
      }

      if (shouldAutoRepair) {
        let repairPrompt = "REPAIR REQUIRED:\n";
        if (autoRepairableViolations.length > 0) repairPrompt += `- [PROTOCOL]\n${autoRepairableViolations.join('\n')}\n`;
        if (technicals.length > 0) repairPrompt += `- [PATCH]\n${technicals.join('\n')}\n`;
        if (!validation.valid) repairPrompt += `- [VALIDATION]\n${validation.errors.join(', ')}\n`;
        if (runtimeErrors.length > 0) repairPrompt += `- [RUNTIME]\n${runtimeErrors.join('\n')}\n`;
        if (noEffectiveChanges) repairPrompt += `- [NO_OP]\nParser reported edits, but resulting files are unchanged.\n`;
        if (inlineNoOp) {
          const candidateFile = extractInlineCandidateFile(result.failedPatches) || 'App.tsx';
          const findSnippet = extractInlineFindSnippet(result.cleanModelText || result.parsedBlocksText || result.rawModelText || '');
          const fileExcerpt = buildFileAnchorExcerpt(sourceFiles[candidateFile] || '', findSnippet, 3);
          repairPrompt += `- [INLINE_ANCHOR]\n`;
          repairPrompt += `candidate_file=${candidateFile}\n`;
          if (findSnippet) repairPrompt += `find_snippet:\n${findSnippet}\n`;
          if (fileExcerpt) repairPrompt += `file_excerpt:\n${fileExcerpt}\n`;
        }
        if (lowConfidence || parserHints.length > 0) {
          repairPrompt += `- [PARSER]\n`;
          repairPrompt += `confidence=${parserConfidence.toFixed(2)} stage=${result.parserStage}\n`;
          if (parserHints.length > 0) repairPrompt += `${parserHints.join('\n')}\n`;
        }
        if (selectedCandidate.warnings.length > 0) repairPrompt += `- [AUTO_FIX]\n${selectedCandidate.warnings.join('\n')}\n`;
        repairPrompt += `\nSTRICT OUTPUT:\n`;
        repairPrompt += `- Return only valid marker blocks.\n`;
        repairPrompt += `- Existing file: <!-- patch: file --> with <replace>/<find>/<with>.\n`;
        repairPrompt += `- New file: <!-- filename: file --> followed by fenced code.\n`;
        repairPrompt += `- No tool wrappers, no prose, no markdown lists outside blocks.\n`;
        return handleSend(
          repairPrompt,
          true,
          repairAttempt + 1,
          verifiedFiles,
          rollbackBaseline,
          attemptIndex,
          'repair',
          true,
          liveApplyDuringStream
        );
      }

      if (hasIssues) {
        const excerptSource = result.parsedBlocksText || result.cleanModelText || result.rawModelText || result.parsedText || result.partialText || '';
        const excerpt = makeExcerpt(excerptSource);
        const blocks: string[] = [];
        if (violations.length > 0) {
          const friendly = violations.map(v =>
            v.includes('No marker blocks found')
              ? 'No editable changes detected. The model did not provide any file blocks.'
              : v
          );
          blocks.push(`Protocol:\n${friendly.join('\n')}`);
        }
        if (technicals.length > 0) blocks.push(`Patch:\n${technicals.join('\n')}`);
        if (!validation.valid) blocks.push(`Validation:\n${validation.errors.join(', ')}`);
        if (runtimeErrors.length > 0) blocks.push(`Runtime:\n${runtimeErrors.join('\n')}`);
        if (noEffectiveChanges) blocks.push('No effective file changes were produced by the patch.');
        if (inlineNoOp) blocks.push('Inline anchor miss: patch was detected but no anchor matched the target file.');
        if (lowConfidence || parserHints.length > 0) {
          blocks.push(`Parser:\nconfidence=${parserConfidence.toFixed(2)} stage=${result.parserStage}${parserHints.length ? `\n${parserHints.join('\n')}` : ''}`);
        }
        if (repeatedRepairSignature) {
          blocks.push('Auto-repair stopped due to repeated identical failure signature.');
        }
        if (selectedCandidate.warnings.length > 0) blocks.push(`Local auto-fixes:\n${selectedCandidate.warnings.join('\n')}`);
        if (repairAttempt >= maxRepairAttempts) blocks.push(`Auto-repair limit reached (${maxRepairAttempts}).`);
        if (excerpt) blocks.push(`Model output excerpt:\n${excerpt}`);
        const failureMsg = `Update failed.\n\n${blocks.join('\n\n')}`;
        setRepairFromEvidencePrompt(buildRepairFromEvidencePrompt({
          userRequest: rawPromptText,
          protocolErrors: autoRepairableViolations,
          patchErrors: technicals,
          validationErrors: validation.errors,
          runtimeErrors,
          parserHints,
          noEffectiveChanges,
          inlineNoOp
        }));

        const keepGeneratedFiles = hasUsableEdits || (!hasHardIssues && hasRuntimeIssues);
        const issueLabel = hasRuntimeIssues ? 'runtime issues' : 'parser warnings';
        const issueOps = keepGeneratedFiles && effectiveChangedFiles.length > 0 ? (result.parserStats?.appliedOps || 0) : 0;
        setChatState(prev => ({
          ...prev,
          files: keepGeneratedFiles ? verifiedFiles : rollbackBaseline,
          isLoading: false,
          statusMessage: keepGeneratedFiles ? "Completed with warnings" : "Failed",
          error: failureMsg,
          messages: [...uiHistory, { role: 'assistant', content: keepGeneratedFiles ? `Update applied with ${issueLabel}.\n\n${failureMsg}` : failureMsg }]
        }));
        setThought(null);
        setRunPhase(keepGeneratedFiles ? 'finalize' : 'failed');
        setLastSummary({
          files: effectiveChangedFiles.length ? effectiveChangedFiles : runFiles,
          ops: issueOps,
          errors: result.failedPatches || [],
          warnings: mergedWarningsFinal
        });
        setCurrentRunDiag(
          keepGeneratedFiles
            ? {
                appliedOps: issueOps,
                changedFiles: effectiveChangedFiles.length ? effectiveChangedFiles : (result.parserStats?.touchedFiles || []),
                noOp: inlineNoOp || noEffectiveChanges
              }
            : {
                appliedOps: 0,
                changedFiles: [],
                noOp: true
              }
        );
        return;
      }

      const summaryFiles = Array.from(new Set([...(runFiles || []), ...(result.parserStats?.touchedFiles || [])]));
      const summaryOps = effectiveChangedFiles.length > 0 ? (result.parserStats?.appliedOps || 0) : 0;
      setLastSummary({ files: effectiveChangedFiles.length ? effectiveChangedFiles : summaryFiles, ops: summaryOps, errors: [], warnings: mergedWarningsFinal });
      setCurrentRunDiag({
        appliedOps: summaryOps,
        changedFiles: effectiveChangedFiles.length ? effectiveChangedFiles : summaryFiles,
        noOp: false
      });

      if (window.electronAPI && projectDir) {
        const nextLabel = `V_${versions.length + 1}`;
        const versionId = `v_${Date.now()}`;
        const summary = rawPromptText.slice(0, 140);
        window.electronAPI.saveVersion({
          projectDir,
          version: {
            id: versionId,
            label: nextLabel,
            createdAt: new Date().toISOString(),
            summary,
            files: verifiedFiles
          }
        }).then((res) => {
          if (res?.success) {
            setVersions(prev => [...prev, { id: versionId, label: nextLabel, createdAt: new Date().toISOString(), summary }]);
          }
        });
      }

      const summaryLines = [
        "Update completed.",
        `Updated files: ${(effectiveChangedFiles.length ? effectiveChangedFiles : summaryFiles).length ? (effectiveChangedFiles.length ? effectiveChangedFiles : summaryFiles).join(', ') : 'none'}`,
        `Applied operations: ${summaryOps}`,
        `Decision: ${decisionReason}`
      ];

      setChatState(prev => ({
        ...prev,
        files: verifiedFiles,
        isLoading: false,
        statusMessage: null,
        messages: [...uiHistory, { role: 'assistant', content: isRepairCall ? "Repair successful." : summaryLines.join('\n') }]
      }));
      setThought(null);
      setRunPhase('finalize');
      setRepairFromEvidencePrompt('');
    } catch (err: any) {
      setChatState(prev => ({ ...prev, files: rollbackBaseline, isLoading: false, error: err.message, statusMessage: "Fault detected." }));
      setThought(null);
      setRunPhase('failed');
      setRepairFromEvidencePrompt('');
    }
  };

  const handleSimpleSubmit = (payload: SimpleComposerPayload) => {
    const composed = composeSimplePrompt(payload);
    setLastComposedSimplePrompt(composed);
    setInput(composed);
    handleSend(
      composed,
      false,
      0,
      undefined,
      undefined,
      1,
      'primary',
      payload.mode !== 'ask',
      config.enableLiveWorkspaceApply ?? false
    );
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatState.messages, chatState.isLoading, runParsed, runMarkers, lastSummary, runVisibleContent]);

  return (
    <div className="flex h-screen w-screen bg-foam-100 dark:bg-ocean-950 text-slate-700 dark:text-slate-300 font-sans overflow-hidden transition-colors duration-300 text-sm">
      {!isConfigured && <ModelInitializationModal config={config} onConfigReady={(c) => { setConfig(c); setIsConfigured(true); }} />}
      
      <div className="w-1/3 min-w-[400px] flex flex-col border-r border-slate-200 dark:border-ocean-800 bg-white dark:bg-ocean-900 shadow-xl z-20 relative">
        <div className="pt-12 pb-6 px-6 border-b border-slate-200 dark:border-ocean-800 flex justify-between items-center bg-white dark:bg-ocean-900 app-drag select-none shrink-0">
          <h1 className="text-xl font-bold tracking-widest uppercase text-slate-800 dark:text-white flex items-center gap-3">
            <img src="/ship42-logo.jpeg" className="h-8 w-8 rounded-md object-cover" alt="Ship-42" /> LocalShip
          </h1>
          <div className="flex items-center gap-2 app-no-drag">
            {config.devMode && config.showAdvancedDebug && (
              <button onClick={() => setIsDebugOpen(true)} className="p-2 hover:bg-slate-100 dark:hover:bg-ocean-800 rounded-full transition-colors text-slate-400" title="Logs">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
              </button>
            )}
            <button onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')} className="p-2 hover:bg-slate-100 dark:hover:bg-ocean-800 rounded-full transition-colors">
              {theme === 'dark' ? <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg> : <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>}
            </button>
            <button onClick={() => setIsSettingsOpen(true)} className="p-2 hover:bg-slate-100 dark:hover:bg-ocean-800 rounded-full transition-colors text-slate-400 group" title="Settings">
              <svg className="h-5 w-5 group-hover:rotate-90 transition-transform duration-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="3" strokeWidth={1.75} />
                <path
                  d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50 dark:bg-ocean-950/30">
          {chatState.messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm animate-fade-in whitespace-pre-wrap break-words ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-white dark:bg-ocean-800 text-slate-700 dark:text-slate-200 rounded-bl-none border border-slate-200 dark:border-ocean-700'}`}>
                {msg.content}
              </div>
            </div>
          ))}
          {(chatState.isLoading || lastSummary || !!runVisibleContent) && (
            <div className="flex justify-start">
              <div className="max-w-[85%]">
                <div className="bg-white dark:bg-ocean-900 border border-slate-200 dark:border-ocean-700 rounded-2xl p-4 shadow-lg">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${chatState.isLoading ? 'bg-blue-600 animate-pulse' : 'bg-green-500'}`}></div>
                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300">
                      {chatState.isLoading
                        ? (runPhase === 'repair'
                            ? 'Repairing'
                            : runPhase === 'preview-check'
                              ? 'Preview Check'
                            : runPhase === 'validate'
                              ? 'Validating'
                              : runPhase === 'patch'
                                ? 'Patching'
                                : 'Planning')
                        : (lastSummary?.errors?.length ? 'Completed With Issues' : 'Completed')}
                    </div>
                  </div>

                  {chatState.isLoading && (
                    <div className="text-xs text-slate-600 dark:text-slate-400 italic leading-relaxed font-serif max-h-32 overflow-y-auto pr-2">
                      {makeExcerpt(runVisibleContent || thought || runParsed || '', 900) || "Analyzing request and preparing edits..."}
                    </div>
                  )}
                  {!chatState.isLoading && !lastSummary && runVisibleContent && (
                    <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed max-h-32 overflow-y-auto pr-2">
                      {makeExcerpt(runVisibleContent, 900)}
                    </div>
                  )}

                  {runMarkers.length > 0 && (
                    <div className="mt-3">
                      <div className="text-[9px] uppercase tracking-widest text-slate-400 mb-2">Edits Detected</div>
                      <div className="flex flex-wrap gap-2">
                        {runMarkers.slice(0, 8).map((m, i) => (
                          <span key={i} className="px-2 py-1 rounded-full bg-slate-100 dark:bg-ocean-800 text-slate-600 dark:text-slate-300 text-[10px] font-bold">
                            {formatMarker(m)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {runWarnings.length > 0 && (
                    <div className="mt-3 text-[10px] text-amber-600">
                      Warnings: {runWarnings.join('; ')}
                    </div>
                  )}

                  {lastSummary && (
                    <div className="mt-4 text-xs text-slate-600 dark:text-slate-400">
                      <div className="text-[9px] uppercase tracking-widest text-slate-400 mb-2">Final Rundown</div>
                      <div>Updated files: {lastSummary.files.length ? lastSummary.files.join(', ') : 'none'}</div>
                      <div>Applied operations: {lastSummary.ops}</div>
                      {runDecisionReason && <div>Decision: {runDecisionReason}</div>}
                      {lastSummary.warnings.length > 0 && (
                        <div className="text-amber-600 mt-1">
                          Warnings: {lastSummary.warnings.join('; ')}
                        </div>
                      )}
                      {lastSummary.errors.length > 0 && (
                        <div className="text-red-500 mt-1">
                          Issues: {lastSummary.errors.map(e => e.includes('No marker blocks found') ? 'No file blocks detected.' : e).join('; ')}
                        </div>
                      )}
                    </div>
                  )}

                  {pendingApplyCandidate && (
                    <div className="mt-3 p-3 rounded-lg border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300 mb-2">Alternative Attempt Available</div>
                      <div className="text-[11px] text-blue-700 dark:text-blue-200 mb-2">
                        {pendingApplyCandidate.reason}
                      </div>
                      <button
                        onClick={() => {
                          setChatState(prev => ({ ...prev, files: pendingApplyCandidate.files }));
                          setLastSummary(prev => prev ? { ...prev, files: pendingApplyCandidate.changedFiles } : prev);
                          setRunDecisionReason(`Manual apply: accepted alternative attempt (${pendingApplyCandidate.changedFiles.join(', ') || 'changed files'}).`);
                          setPendingApplyCandidate(null);
                        }}
                        className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold uppercase tracking-widest"
                      >
                        Apply This Attempt
                      </button>
                    </div>
                  )}

                  {!chatState.isLoading && repairFromEvidencePrompt && (
                    <div className="mt-3 p-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-300 mb-2">Manual Recovery</div>
                      <p className="text-[11px] text-amber-700 dark:text-amber-200 mb-2">
                        Use structured failure evidence for a clean retry.
                      </p>
                      <button
                        onClick={() => handleSend(
                          repairFromEvidencePrompt,
                          true,
                          0,
                          undefined,
                          undefined,
                          1,
                          'repair',
                          true,
                          config.enableLiveWorkspaceApply ?? false
                        )}
                        className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-bold uppercase tracking-widest"
                      >
                        Repair From Evidence
                      </button>
                    </div>
                  )}

                  <div className="mt-3">
                    <button
                      onClick={() => setShowDevDetails(prev => !prev)}
                      className="text-[10px] font-bold uppercase tracking-widest text-blue-600 dark:text-teal-400 hover:text-blue-700"
                    >
                      {showDevDetails ? 'Hide Developer Details' : 'Show Developer Details'}
                    </button>
                    {showDevDetails && (
                      <pre className="mt-3 max-h-48 overflow-y-auto bg-slate-50 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-800 rounded-xl p-3 text-[10px] text-slate-700 dark:text-slate-200 whitespace-pre-wrap font-mono">
                        {runParsed.trim() || "No parsed changes yet."}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-ocean-800 bg-white dark:bg-ocean-900 shrink-0">
          <div className="mb-3 flex items-center justify-end">
            <button
              onClick={openAssetPicker}
              className="group inline-flex h-9 items-center gap-2 px-3 bg-slate-100 dark:bg-ocean-800 border border-slate-200 dark:border-ocean-700 rounded-lg text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-ocean-700 transition-colors"
              title="Add assets"
              aria-label="Add assets"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-[10px] font-bold uppercase tracking-widest">Add assets</span>
            </button>
          </div>
          {(config.uiMode || 'simple') === 'simple' ? (
            <SimpleComposer
              draft={simpleDraft}
              askInput={askInput}
              isIterationContext={isIterationContext}
              isLoading={chatState.isLoading}
              isConfigured={isConfigured}
              actionMode={actionMode}
              onDraftChange={setSimpleDraft}
              onAskInputChange={setAskInput}
              onActionModeChange={setActionMode}
              onSubmit={handleSimpleSubmit}
            />
          ) : (
            <div className="relative">
              <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input, false, 0, undefined, undefined, 1, 'primary', true, config.enableLiveWorkspaceApply ?? false); }}} placeholder="Describe the change..." className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-700 rounded-xl pl-4 pr-12 py-3 focus:ring-2 focus:ring-blue-600 outline-none resize-none h-24 text-sm" />
              <button onClick={() => handleSend(input, false, 0, undefined, undefined, 1, 'primary', true, config.enableLiveWorkspaceApply ?? false)} disabled={chatState.isLoading || !input.trim() || !isConfigured} className="absolute bottom-3 right-3 p-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 rounded-lg text-white shadow-lg active:scale-95 transition-all">
                {chatState.isLoading ? <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div> : <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg>}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 p-8 flex flex-col relative bg-foam-50 dark:bg-ocean-950 transition-colors duration-300">
        <div className="flex justify-between items-center mb-6 shrink-0">
          <h2 className="text-2xl font-light text-slate-800 dark:text-white flex items-center gap-3"><span className="text-slate-300 dark:text-ocean-700 font-thin">///</span> WORKSPACE <span className="text-xs uppercase tracking-widest text-slate-400">{projectName}</span></h2>
          <div className="flex gap-4 items-center">
            {window.electronAPI && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-widest text-slate-400">Version</span>
                <select
                  value={selectedVersionId}
                  onChange={async (e) => {
                    const id = e.target.value;
                    setSelectedVersionId(id);
                    if (id === 'main') return;
                    if (window.electronAPI && projectDir) {
                      const res = await window.electronAPI.loadVersion({ projectDir, id });
                      if (res?.files) {
                        setChatState(p => ({ ...p, files: res.files }));
                      }
                    }
                  }}
                  className="bg-white dark:bg-ocean-900 border border-slate-200 dark:border-ocean-800 rounded-lg px-2 py-1 text-[10px] uppercase tracking-widest text-slate-500"
                >
                  <option value="main">MAIN (Working)</option>
                  {[...versions].reverse().map(v => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </div>
            )}
            {(config.uiMode || 'simple') === 'advanced' && config.devMode && (
              <div className="bg-white dark:bg-ocean-900 border border-slate-200 dark:border-ocean-800 rounded-lg p-1 flex shadow-sm">
                <button onClick={() => setViewMode('preview')} className={`px-4 py-1 text-xs font-bold uppercase rounded-md transition-all ${viewMode === 'preview' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-800 dark:hover:text-white'}`}>Preview</button>
                <button onClick={() => setViewMode('code')} className={`px-4 py-1 text-xs font-bold uppercase rounded-md transition-all ${viewMode === 'code' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-800 dark:hover:text-white'}`}>Code</button>
              </div>
            )}
            <div className="relative">
              <button onClick={() => setIsExportMenuOpen(!isExportMenuOpen)} className="flex items-center gap-3 px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-black uppercase tracking-[0.1em] transition-all shadow-xl active:scale-95 group">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                Ship App
                <svg className={`w-3 h-3 transition-transform duration-300 ${isExportMenuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {isExportMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsExportMenuOpen(false)}></div>
                  <div className="absolute right-0 mt-3 w-64 bg-white dark:bg-ocean-900 border border-slate-200 dark:border-ocean-800 rounded-2xl shadow-2xl z-50 overflow-hidden py-1.5 animate-fade-in-up">
                    <button onClick={() => { exportProject(chatState.files, projectDetails, undefined, config.targetPlatform); setIsExportMenuOpen(false); }} className="w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-ocean-800 flex items-center gap-4 group transition-colors">
                      <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-ocean-950 flex items-center justify-center text-lg group-hover:scale-110 transition-transform">📦</div>
                      <div className="flex flex-col"><span className="text-sm font-bold text-slate-800 dark:text-white">Download ZIP</span><span className="text-[10px] text-slate-400">Complete source code</span></div>
                    </button>
                    {window.electronAPI && (
                      <button onClick={() => { setIsBuildModalOpen(true); setIsExportMenuOpen(false); }} className="w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-ocean-800 flex items-center gap-4 group border-t border-slate-100 dark:border-ocean-800 transition-colors">
                        <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-lg group-hover:scale-110 transition-transform text-blue-600">🚀</div>
                        <div className="flex flex-col"><span className="text-sm font-bold text-slate-800 dark:text-white">Build Native App</span><span className="text-[10px] text-slate-400">Generate DMG / EXE / AppImage</span></div>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 relative bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-ocean-800 overflow-hidden shadow-2xl">
           <div className="absolute inset-0">
             <div className={`${viewMode === 'preview' ? 'block' : 'hidden'} absolute inset-0`}>
               <PreviewFrame
                 files={chatState.files}
                 isLoading={chatState.isLoading}
                 devMode={config.devMode}
                 lastGoodFallbackEnabled={(config.previewFailureMode || 'last-good') === 'last-good'}
                 onPreviewStatus={handlePreviewStatus}
                 onTestReport={handleTestReport}
               />
             </div>
             <div className={`${viewMode === 'code' ? 'block' : 'hidden'} absolute inset-0`}>
               <IdeView files={chatState.files} onUpdateFile={(name, code) => setChatState(p => ({ ...p, files: { ...p.files, [name]: code }}))} />
             </div>
           </div>
        </div>
        <input
          ref={assetInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*,audio/*,video/*,.glb,.gltf,.bin,.woff,.woff2,.ttf,.otf,.pdf"
          onChange={handleAssetInputChange}
        />
      </div>

      <ConfigModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={config}
        projectDir={projectDir}
        onSave={setConfig}
      />
      <BuildModal
        isOpen={isBuildModalOpen}
        onClose={() => setIsBuildModalOpen(false)}
        initialDetails={projectDetails}
        initialTargetPlatform={config.targetPlatform}
        initialOutputDir={config.outputDir}
        onBuild={async (details, platform, outputDir) => {
          setProjectDetails(details);
          setConfig(prev => ({ ...prev, targetPlatform: platform, outputDir }));
          await buildProjectLocally(chatState.files, details, outputDir, platform, (l) => console.log(l));
        }}
      />
      <ProjectSetupModal
        isOpen={isProjectSetupOpen}
        onClose={() => setIsProjectSetupOpen(false)}
        initialMode={setupDefaults?.mode}
        initialName={setupDefaults?.name}
        initialBaseDir={setupDefaults?.baseDir}
        initialExistingDir={setupDefaults?.existingDir}
        onConfirm={async ({ mode, name, baseDir, existingDir }) => {
          if (!window.electronAPI) return;
          if (mode === 'new') {
            const res = await window.electronAPI.initProject({ baseDir: baseDir || '', name });
            setProjectDir(res.projectDir);
            setProjectName(name);
            localStorage.setItem('localship.projectDir', res.projectDir);
            localStorage.setItem('localship.projectName', name);
            const list = await window.electronAPI.listVersions({ projectDir: res.projectDir });
            setVersions(list);
            window.electronAPI.saveWorkspace({ projectDir: res.projectDir, files: chatState.files }).catch(() => {});
            setIsProjectSetupOpen(false);
            return;
          }

          const importDir = existingDir || '';
          const res = await window.electronAPI.importProject({ projectDir: importDir });
          setProjectDir(importDir);
          setProjectName(name);
          localStorage.setItem('localship.projectDir', importDir);
          localStorage.setItem('localship.projectName', name);
          if (res?.files) {
            const seededFiles = ensureSeedWorkspaceFiles(res.files);
            setChatState(prev => ({ ...prev, files: seededFiles }));
            window.electronAPI.saveWorkspace({ projectDir: importDir, files: seededFiles }).catch(() => {});
          }
          const list = await window.electronAPI.listVersions({ projectDir: importDir });
          setVersions(list);
          setIsProjectSetupOpen(false);
        }}
      />

      {config.devMode && config.showAdvancedDebug && isDebugOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-100/80 dark:bg-slate-900/80 backdrop-blur-xl p-8">
           <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 w-full max-w-6xl h-full flex flex-col rounded-2xl shadow-2xl overflow-hidden">
              <div className="px-6 py-4 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center shrink-0">
                 <h3 className="text-xs font-black uppercase tracking-[0.2em] text-slate-600 dark:text-slate-400">Advanced Debug Suite (Persistent Session Logs)</h3>
                 <button onClick={() => setIsDebugOpen(false)} className="text-[10px] font-bold uppercase text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white tracking-widest bg-slate-200 dark:bg-slate-700 px-3 py-1 rounded-full">Close Console</button>
              </div>
              <div className="flex-1 grid grid-cols-3 overflow-hidden bg-white dark:bg-black text-[11px] font-mono leading-relaxed">
                 <div className="border-r border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden">
                    <h4 className="p-4 text-purple-600 dark:text-purple-400 font-bold uppercase tracking-widest border-b border-slate-200 dark:border-slate-800 shrink-0">Full Raw Model Text</h4>
                    {(debugDroppedChars.timeline > 0 || debugDroppedChars.rawModel > 0 || debugDroppedChars.wire > 0) && (
                      <div className="px-3 py-2 text-[9px] uppercase tracking-widest text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-900/40">
                        Truncated log data: timeline {debugDroppedChars.timeline}, raw {debugDroppedChars.rawModel}, wire {debugDroppedChars.wire}
                      </div>
                    )}
                    {runTimelineLog && (
                      <pre className="max-h-24 p-3 overflow-auto text-slate-500 dark:text-slate-400 whitespace-pre-wrap font-mono border-b border-slate-200 dark:border-slate-800">{runTimelineLog}</pre>
                    )}
                    <pre className="flex-1 p-4 overflow-auto text-slate-700 dark:text-purple-200/60 whitespace-pre-wrap font-mono">{rawModelTextLog || "History empty."}</pre>
                    {config.showWireDebug && (
                      <>
                        <h4 className="p-3 text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest border-t border-slate-200 dark:border-slate-800 shrink-0">Wire Stream (Developer)</h4>
                        <pre className="max-h-40 p-3 overflow-auto text-slate-600 dark:text-slate-400 whitespace-pre-wrap font-mono border-t border-slate-200 dark:border-slate-800">{rawWireTextLog || "No wire frames captured."}</pre>
                      </>
                    )}
                 </div>
                 <div className="border-r border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden">
                    <h4 className="p-4 text-green-600 dark:text-green-400 font-bold uppercase tracking-widest border-b border-slate-200 dark:border-slate-800 shrink-0">Aggregated Session Output</h4>
                    {debugDroppedChars.parsed > 0 && (
                      <div className="px-3 py-2 text-[9px] uppercase tracking-widest text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-900/40">
                        Truncated parsed log chars: {debugDroppedChars.parsed}
                      </div>
                    )}
                    <pre className="flex-1 p-4 overflow-auto text-slate-700 dark:text-green-500/90 whitespace-pre-wrap font-mono">{rawOutput || "No session data extracted."}</pre>
                 </div>
                 <div className="flex flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
                    <h4 className="p-4 text-amber-600 dark:text-amber-400 font-bold uppercase tracking-widest border-b border-slate-200 dark:border-slate-800 shrink-0">Diagnostics Dashboard</h4>
                    <div className="flex-1 p-4 overflow-auto space-y-6 text-slate-600 dark:text-slate-300">
                        <div className="grid grid-cols-3 gap-4">
                           <div className="bg-white dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                              <p className="text-[9px] text-slate-500 uppercase mb-1">Current Run Ops</p>
                              <div className="text-2xl font-black text-emerald-600 dark:text-emerald-500">{currentRunDiag.appliedOps || 0}</div>
                           </div>
                           <div className="bg-white dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                              <p className="text-[9px] text-slate-500 uppercase mb-1">Current Run Files</p>
                              <div className="text-2xl font-black text-indigo-600 dark:text-indigo-500">{currentRunDiag.changedFiles?.length || 0}</div>
                           </div>
                           <div className="bg-white dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                              <p className="text-[9px] text-slate-500 uppercase mb-1">Current Run No-Op</p>
                              <div className={`text-2xl font-black ${currentRunDiag.noOp ? 'text-red-600 dark:text-red-500' : 'text-emerald-600 dark:text-emerald-500'}`}>
                                {currentRunDiag.noOp ? 'YES' : 'NO'}
                              </div>
                           </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                           <div className="bg-white dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                              <p className="text-[9px] text-slate-500 uppercase mb-1">Session Markers Found</p>
                              <div className="text-2xl font-black text-amber-600 dark:text-amber-500">{diagData.markerCount || 0}</div>
                           </div>
                           <div className="bg-white dark:bg-slate-900/50 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                              <p className="text-[9px] text-slate-500 uppercase mb-1">Session Ops Applied</p>
                              <div className="text-2xl font-black text-blue-600 dark:text-blue-500">{diagData.appliedOps || 0}</div>
                           </div>
                        </div>

                        {diagData.markers?.length > 0 && (
                          <div>
                            <p className="text-[9px] text-slate-500 uppercase mb-2">Marker Timeline:</p>
                            <div className="flex flex-wrap gap-1">
                              {diagData.markers.map((m: string, i: number) => (
                                <span key={i} className="bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-2 py-0.5 rounded text-[9px]">{m}</span>
                              ))}
                            </div>
                          </div>
                        )}

                        {diagData.touchedFiles?.length > 0 && (
                          <div>
                            <p className="text-[9px] text-green-600 dark:text-green-500 uppercase mb-2 font-bold">Files Updated in Session:</p>
                            <ul className="space-y-1 text-green-600 dark:text-green-400/80">
                              {diagData.touchedFiles.map((f: string, i: number) => <li key={i}>✔ {f}</li>)}
                            </ul>
                          </div>
                        )}

                        {diagData.failures?.length > 0 && (
                          <div>
                            <p className="text-[9px] text-red-600 dark:text-red-500 uppercase mb-2 font-bold">Persistent Session Errors:</p>
                            <ul className="space-y-1">
                              {diagData.failures.map((f: string, i: number) => <li key={i} className="bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 p-2 rounded border border-red-200 dark:border-red-900/50 break-words font-mono text-[9px]">{f}</li>)}
                            </ul>
                            <button onClick={() => { failuresRef.current = []; setDiagData((p: any) => ({ ...p, failures: [] })); }} className="text-[8px] text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 mt-2 uppercase tracking-widest">Clear Errors</button>
                          </div>
                        )}
                        
                        {testReport && (
                          <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
                            <p className="text-[9px] text-slate-500 uppercase mb-2 font-bold text-blue-600 dark:text-blue-400 font-mono">Latest Integration Check:</p>
                            <pre className="text-blue-700 dark:text-blue-300/80 bg-blue-50 dark:bg-blue-950/20 p-2 rounded border border-blue-200 dark:border-blue-900/50 font-mono text-[10px]">{JSON.stringify(testReport, null, 2)}</pre>
                          </div>
                        )}

                    </div>
                 </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default App;
