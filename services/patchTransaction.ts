import { ProjectFiles } from '../types';

export interface PatchTransactionResult {
  files: ProjectFiles;
  changedFiles: string[];
  changedCount: number;
  hasRealDiff: boolean;
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
}

const hashText = (text: string): string => {
  // Lightweight deterministic hash for in-memory diff bookkeeping.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
};

export const hashProjectFiles = (files: ProjectFiles): Record<string, string> => {
  const out: Record<string, string> = {};
  Object.keys(files).sort().forEach((name) => {
    out[name] = hashText(String(files[name] || ''));
  });
  return out;
};

export const getChangedFilesBetween = (before: ProjectFiles, after: ProjectFiles): string[] => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  keys.forEach((key) => {
    const prev = before[key] ?? '';
    const next = after[key] ?? '';
    if (prev !== next) changed.push(key);
  });
  return changed.sort();
};

export const runPatchTransaction = (
  baseline: ProjectFiles,
  applyFn: (draft: ProjectFiles) => void
): PatchTransactionResult => {
  const before = { ...baseline };
  const draft = { ...baseline };
  applyFn(draft);
  const changedFiles = getChangedFilesBetween(before, draft);
  return {
    files: draft,
    changedFiles,
    changedCount: changedFiles.length,
    hasRealDiff: changedFiles.length > 0,
    beforeHashes: hashProjectFiles(before),
    afterHashes: hashProjectFiles(draft)
  };
};
