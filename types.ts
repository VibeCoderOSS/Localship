
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type TargetPlatform = 'mac-arm64' | 'mac-intel' | 'windows' | 'linux';
export type ModelTierPreference = 'auto' | 'small' | 'large';
export type PreviewFailureMode = 'last-good' | 'strict-fail';
export type ParserStage = 'raw' | 'normalized' | 'markers' | 'fallback';
export type ProviderFamily = 'auto' | 'qwen' | 'generic';
export type ApiProvider = 'lmstudio' | 'ollama';
export type SamplingProfile = 'provider-default' | 'strict-deterministic';
export type ModelLookupMode = 'off' | 'hf-cache' | 'hf-live';
export type ModelProfileSource = 'metadata' | 'name' | 'manual' | 'unknown' | 'hf';
export type QualityMode = 'single-pass' | 'adaptive-best-of-2' | 'always-best-of-2';
export type UiMode = 'simple' | 'advanced';
export type ParseMode = 'stream-lite' | 'final-full';

export interface AppConfig {
  apiUrl: string;
  apiProvider?: ApiProvider;
  model: string;
  systemPrompt: string;
  modelTierPreference?: ModelTierPreference;
  providerFamily?: ProviderFamily;
  samplingProfile?: SamplingProfile;
  samplingOverrideEnabled?: boolean;
  modelLookupMode?: ModelLookupMode;
  modelLookupTtlHours?: number;
  qualityMode?: QualityMode;
  uiMode?: UiMode;
  autoRepairAttempts?: number;
  previewFailureMode?: PreviewFailureMode;
  enableLiveWorkspaceApply?: boolean;
  debugTextBudgetChars?: number;
  streamParseCadenceMs?: number;
  ollamaContextSize?: number;
  showAdvancedDebug?: boolean;
  showWireDebug?: boolean;
  outputDir?: string; 
  targetPlatform: TargetPlatform;
  devMode: boolean; 
}

export interface ProjectDetails {
  name: string;
  author: string;
  icon: File | null;
}

export interface GeneratedFile {
  filename: string;
  content: string;
}

export type ProjectFiles = Record<string, string>;

export interface PlanStep {
  id: string; // "step-1"
  label: string;
  status: 'pending' | 'active' | 'completed';
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  statusMessage: string | null;
  error: string | null;
  files: ProjectFiles; 
}

export interface BuildData {
  appName: string;
  files: ProjectFiles; 
  mainJs: string;
  preloadJs: string;
  packageJson: string;
  readme: string;
  iconBuffer: ArrayBuffer | null;
  outputDir?: string;
  targetPlatform: TargetPlatform;
}

export interface BuildResult {
  success: boolean;
  error?: string;
  path?: string;
  warning?: string;
  primaryArtifact?: string;
  artifacts?: string[];
}

export interface PreviewStatus {
  candidateOk: boolean;
  usedLastGood: boolean;
  errors: string[];
  stage?: 'preflight' | 'compile' | 'mount' | 'smoke';
  warnings?: string[];
  autoHealed?: string[];
  paused?: boolean;
  dirtyWhilePaused?: boolean;
}

export interface ParserStats {
  markerCount: number;
  markers: string[];
  appliedOps: number;
  touchedFiles: string[];
}

export interface RunCandidateScore {
  validationDelta: number;
  runtimeOk: boolean;
  changedFiles: number;
  appliedOps: number;
  hardFailures: number;
  score: number;
}

export interface SimpleComposerDraft {
  goal: string;
  style?: string;
  mustHave?: string;
  notes?: string;
}

export interface SimpleComposerPayload extends SimpleComposerDraft {
  mode: 'ask' | 'build' | 'iterate';
}

export interface ComposedPromptResult {
  prompt: string;
  omittedFields: Array<'style' | 'mustHave' | 'notes'>;
}

export interface StreamUpdate {
  rawModelText: string;
  rawWireText: string;
  cleanModelText: string;
  parsedBlocksText: string;
  parserStage: ParserStage;
  repairHints: string[];
  channelStats?: {
    contentChars: number;
    reasoningChars: number;
    toolArgChars: number;
    wireChars: number;
  };
  attemptIndex?: number;
  attemptType?: 'primary' | 'retry' | 'repair';
  decisionReason?: string;
  hasRealDiff?: boolean;
  lineEditRescueApplied?: boolean;
  lineEditRescueTarget?: string;
  parseMode?: ParseMode;
  droppedDebugChars?: number;
  parserConfidence?: number;
  partialText: string;
  rawSse: string;
  parsedText: string;
  warnings: string[];
  files: ProjectFiles;
  failedPatches: string[]; 
  thought: string | null;
  parserStats: ParserStats;
  isFinal: boolean;
  deltaRaw: string;
  deltaRawWire: string;
  deltaClean: string;
  deltaParsed: string;
}

export interface ElectronAPI {
  isElectron: boolean;
  buildApp: (data: BuildData) => Promise<BuildResult>;
  selectDirectory: () => Promise<string | null>;
  compileTailwind: (data: { files: ProjectFiles; configCode: string; cssInput: string }) => Promise<{ css?: string; error?: string; warning?: string }>;
  onBuildLog: (callback: (msg: string) => void) => void;
  onBuildError: (callback: (msg: string) => void) => void;
  removeListeners: () => void;
  initProject: (data: { baseDir: string; name: string }) => Promise<{ projectDir: string }>;
  validateProjectDir: (data: { projectDir: string }) => Promise<{ exists: boolean }>;
  importProject: (data: { projectDir: string }) => Promise<{ files: ProjectFiles }>;
  saveWorkspace: (data: { projectDir: string; files: ProjectFiles }) => Promise<{ success: boolean; error?: string }>;
  loadWorkspace: (data: { projectDir: string }) => Promise<{ files: ProjectFiles | null }>;
  listVersions: (data: { projectDir: string }) => Promise<Array<{ id: string; label: string; createdAt: string; summary?: string }>>;
  saveVersion: (data: { projectDir: string; version: { id: string; label: string; createdAt: string; summary?: string; files: ProjectFiles } }) => Promise<{ success: boolean; error?: string }>;
  loadVersion: (data: { projectDir: string; id: string }) => Promise<{ files: ProjectFiles; meta: { id: string; label: string; createdAt: string; summary?: string } }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
