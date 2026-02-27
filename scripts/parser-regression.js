/* eslint-disable no-console */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const normalizeText = (text) => String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const normalizeToolMarkers = (text) => {
  let out = normalizeText(text);
  out = out.replace(/<function\s*=\s*patch:\s*([^>\s]+)\s*>/gi, (_m, fileRaw) => {
    const file = String(fileRaw || '').trim().replace(/["']/g, '');
    return `<!-- patch: ${file} -->`;
  });
  out = out.replace(/<patch:\s*([^>\n]+?)\s*>/gi, (_m, fileRaw) => {
    const file = String(fileRaw || '').trim().replace(/["']/g, '');
    return `<!-- patch: ${file} -->`;
  });
  out = out.replace(/<\/?\s*(tool_call|toolcall|tool|function_call)\b[^>]*>/gi, '');
  return out;
};

const normalizeBrokenClosings = (text) => {
  let out = normalizeText(text);
  ['replace', 'insert_before', 'insert_after', 'delete', 'create', 'find', 'with'].forEach((tag) => {
    const rx = new RegExp(`</${tag}(?=\\s|$|<)`, 'gi');
    out = out.replace(rx, `</${tag}>`);
  });
  out = out.replace(/<\/\s*$/g, '');
  return out;
};

const markerCount = (text) => {
  const matches = text.match(/<!--\s*(filename|patch):\s*([^\s>]+)\s*-->/gmi);
  return matches ? matches.length : 0;
};

const extractInlineReplaceOps = (text) => {
  const bodyNorm = normalizeText(text).trim().replace(/^```[a-z]*\n/i, '').replace(/```$/i, '').trim();
  const ops = [];
  const wrapperRanges = [];

  const wrapperRegex = /<replace>([\s\S]*?)<\/replace>/gi;
  let wMatch = null;
  while ((wMatch = wrapperRegex.exec(bodyNorm)) !== null) {
    wrapperRanges.push({ start: wMatch.index, end: wMatch.index + wMatch[0].length });
    const inner = wMatch[1];
    const findMatch = /<find>([\s\S]*?)<\/find>/i.exec(inner);
    const withMatch = /<with>([\s\S]*?)<\/with>/i.exec(inner);
    const findText = findMatch ? normalizeText(findMatch[1]).trim() : '';
    const withText = withMatch ? normalizeText(withMatch[1]).trim() : '';
    if (findText && withText) ops.push({ find: findText, with: withText });
  }

  const isInsideWrapper = (idx) => wrapperRanges.some((r) => idx >= r.start && idx < r.end);
  const siblingRegex = /<find>([\s\S]*?)<\/find>\s*<with>([\s\S]*?)<\/with>/gi;
  let sMatch = null;
  while ((sMatch = siblingRegex.exec(bodyNorm)) !== null) {
    if (isInsideWrapper(sMatch.index)) continue;
    const findText = normalizeText(sMatch[1]).trim();
    const withText = normalizeText(sMatch[2]).trim();
    if (findText && withText) ops.push({ find: findText, with: withText });
  }
  return ops;
};

const dedupeInlineOps = (ops) => {
  const seen = new Set();
  const out = [];
  for (const op of ops) {
    const key = `${op.find}\n---\n${op.with}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(op);
  }
  return out;
};

const locateAnchor = (source, find) => {
  const src = normalizeText(source);
  const needle = normalizeText(find);
  const exactCount = needle ? src.split(needle).length - 1 : 0;
  if (exactCount === 1) {
    return { start: src.indexOf(needle), matched: needle, count: 1 };
  }

  const norm = (s) => s.trim();
  const stripComment = (s) => s.replace(/\s*\/\/.*$/, '').trim();
  const sourceLines = src.split('\n');
  const findLines = needle.split('\n').filter((l) => l.trim().length > 0);
  if (findLines.length === 0) return { start: -1, matched: '', count: 0 };

  const checkHits = (lineNormalizer) => {
    const hits = [];
    for (let i = 0; i <= sourceLines.length - findLines.length; i++) {
      let ok = true;
      for (let j = 0; j < findLines.length; j++) {
        if (lineNormalizer(sourceLines[i + j]) !== lineNormalizer(findLines[j])) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    return hits;
  };

  let hits = checkHits(norm);
  if (hits.length === 0) hits = checkHits(stripComment);
  if (hits.length === 1) {
    const i = hits[0];
    const matched = sourceLines.slice(i, i + findLines.length).join('\n');
    const start = sourceLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
    return { start, matched, count: 1 };
  }
  if (hits.length > 1) return { start: -1, matched: '', count: hits.length };
  return { start: -1, matched: '', count: 0 };
};

const applyInlinePatchToBestFile = (files, text) => {
  const cleaned = normalizeBrokenClosings(normalizeToolMarkers(text));
  const ops = dedupeInlineOps(extractInlineReplaceOps(cleaned));
  if (ops.length === 0) return { files: { ...files }, appliedOps: 0, changedFiles: [], noOp: true, ambiguous: false };

  const candidates = [];
  for (const [file, content] of Object.entries(files)) {
    let next = content;
    let appliedOps = 0;
    let ambiguous = false;
    for (const op of ops) {
      const hit = locateAnchor(next, op.find);
      if (hit.count > 1) {
        ambiguous = true;
        break;
      }
      if (hit.start === -1) continue;
      const before = next;
      next = next.slice(0, hit.start) + op.with + next.slice(hit.start + hit.matched.length);
      if (next !== before) appliedOps += 1;
    }
    if (ambiguous) continue;
    if (appliedOps > 0 && next !== content) {
      candidates.push({ file, content: next, appliedOps, score: appliedOps * 100 + (appliedOps === ops.length ? 1 : 0) });
    }
  }

  if (candidates.length === 0) {
    return { files: { ...files }, appliedOps: 0, changedFiles: [], noOp: true, ambiguous: false };
  }

  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const topScore = candidates[0].score;
  const top = candidates.filter((c) => c.score === topScore);
  if (top.length > 1) {
    return { files: { ...files }, appliedOps: 0, changedFiles: [], noOp: false, ambiguous: true };
  }

  const chosen = top[0];
  const nextFiles = { ...files, [chosen.file]: chosen.content };
  return { files: nextFiles, appliedOps: chosen.appliedOps, changedFiles: [chosen.file], noOp: false, ambiguous: false };
};

const runNormalizationFixture = (fixture) => {
  const cleaned = normalizeBrokenClosings(normalizeToolMarkers(fixture.input));
  const count = markerCount(cleaned);
  if (typeof fixture.expectedMarkerCount === 'number') {
    assert(count === fixture.expectedMarkerCount, `${fixture.name}: markerCount expected ${fixture.expectedMarkerCount}, got ${count}`);
  }
  if (fixture.mustContain) {
    fixture.mustContain.forEach((needle) => assert(cleaned.includes(needle), `${fixture.name}: missing "${needle}"`));
  }
  if (fixture.mustNotContain) {
    fixture.mustNotContain.forEach((needle) => assert(!cleaned.includes(needle), `${fixture.name}: should not contain "${needle}"`));
  }
};

const normalizationFixtures = [
  {
    name: 'valid marker filename block',
    input: '<!-- filename: App.tsx -->\n```tsx\nexport default function App(){return null}\n```',
    expectedMarkerCount: 1
  },
  {
    name: 'tool wrapper is stripped',
    input: '<tool_call>\n<!-- patch: App.tsx -->\n<replace><find>a</find><with>b</with></replace>\n</tool_call>',
    expectedMarkerCount: 1,
    mustNotContain: ['<tool_call>', '</tool_call>']
  },
  {
    name: 'patch wrapper conversion',
    input: '<patch: App.tsx>\n<replace><find>a</find><with>b</with></replace>',
    expectedMarkerCount: 1,
    mustContain: ['<!-- patch: App.tsx -->']
  },
  {
    name: 'broken closings repaired',
    input: '<replace><find>a</find><with>b</with></replace',
    expectedMarkerCount: 0,
    mustContain: ['</replace>']
  },
  {
    name: 'function patch wrapper conversion',
    input: '<function=patch:App.tsx>\n<replace><find>a</find><with>b</with></replace>\n</function>',
    expectedMarkerCount: 1,
    mustContain: ['<!-- patch: App.tsx -->']
  }
];

const inlinePatchFixtures = () => {
  const baseFiles = {
    'App.tsx': [
      "import React, { useState } from 'react';",
      '',
      'const GRAVITY = 0.45; // Reduced gravity for realistic falling speed',
      'const JUMP_STRENGTH = -7; // Adjusted jump strength to match gravity',
      '',
      'export default function App(){ return <div/>; }'
    ].join('\n'),
    'index.tsx': "import React from 'react';\nimport App from './App';\n"
  };

  const duplicateInlineInput = `
<tool_call>
<replace>
  <find>
const GRAVITY = 0.45; // Reduced gravity for realistic falling speed
const JUMP_STRENGTH = -7; // Adjusted jump strength to match gravity
  </find>
  <with>
const GRAVITY = 0.25; // Reduced gravity for realistic falling speed
const JUMP_STRENGTH = -6; // Adjusted jump strength to match gravity
  </with>
</replace>
<tool_call>
<replace>
  <find>
const GRAVITY = 0.45; // Reduced gravity for realistic falling speed
const JUMP_STRENGTH = -7; // Adjusted jump strength to match gravity
  </find>
  <with>
const GRAVITY = 0.25; // Reduced gravity for realistic falling speed
const JUMP_STRENGTH = -6; // Adjusted jump strength to match gravity
  </with>
</replace>`;
  const r1 = applyInlinePatchToBestFile(baseFiles, duplicateInlineInput);
  assert(r1.appliedOps === 1, `duplicate inline replace: expected appliedOps=1, got ${r1.appliedOps}`);
  assert(r1.changedFiles.includes('App.tsx'), 'duplicate inline replace: expected App.tsx to change');
  assert(r1.files['App.tsx'].includes('const GRAVITY = 0.25;'), 'duplicate inline replace: gravity not updated');

  const commentDriftInput = `
<replace>
  <find>
const GRAVITY = 0.45;
const JUMP_STRENGTH = -7;
  </find>
  <with>
const GRAVITY = 0.30;
const JUMP_STRENGTH = -6.5;
  </with>
</replace>`;
  const r2 = applyInlinePatchToBestFile(baseFiles, commentDriftInput);
  assert(r2.appliedOps === 1, `comment drift: expected appliedOps=1, got ${r2.appliedOps}`);
  assert(r2.changedFiles.includes('App.tsx'), 'comment drift: expected App.tsx to change');
  assert(r2.files['App.tsx'].includes('const GRAVITY = 0.30;'), 'comment drift: gravity not updated');

  const trueMissInput = `
<replace>
  <find>
const DOES_NOT_EXIST = 1;
  </find>
  <with>
const DOES_NOT_EXIST = 2;
  </with>
</replace>`;
  const r3 = applyInlinePatchToBestFile(baseFiles, trueMissInput);
  assert(r3.appliedOps === 0, `true anchor miss: expected appliedOps=0, got ${r3.appliedOps}`);
  assert(r3.changedFiles.length === 0, `true anchor miss: expected no changed files, got ${r3.changedFiles.join(',')}`);
  assert(r3.noOp === true, 'true anchor miss: expected noOp=true');

  const malformedTailWithMarkerInput = `
<tool_call>
<replace>
  <find>
const GRAVITY = 0.45; // Reduced gravity for realistic falling speed
const JUMP_STRENGTH = -7; // Adjusted jump strength to match gravity
  </find>
  <with>
const GRAVITY = 0.25; // Slower falling speed
const JUMP_STRENGTH = -6; // Adjusted jump strength for slower gravity
  </with>
</replace>
<!-- patch: App.tsx -->
<replace>
  <find>
const GRAVITY = 0.45; // Reduced gravity for realistic falling speed
const JUMP_STRENGTH = -7; // Adjusted jump strength to match gravity
  </find>
  <with>
const GRAVITY = 0.25; // Slower falling speed
const JUMP_STRENGTH = -6; // Adjusted jump strength for slower gravity
  </with>
</`;
  const r4 = applyInlinePatchToBestFile(baseFiles, malformedTailWithMarkerInput);
  assert(r4.appliedOps === 1, `malformed tail + marker: expected appliedOps=1, got ${r4.appliedOps}`);
  assert(r4.changedFiles.includes('App.tsx'), 'malformed tail + marker: expected App.tsx to change');
  assert(r4.files['App.tsx'].includes('const GRAVITY = 0.25;'), 'malformed tail + marker: gravity not updated');

  const markerFailureInlineRescueInput = `
<!-- patch: App.tsx -->
<replace>
  <find>
const GRAVITY = 0.45;
const JUMP_STRENGTH = -7;
  </find>
  <with>
const GRAVITY = 0.28;
const JUMP_STRENGTH = -6.2;
  </with>
</`;
  const r5 = applyInlinePatchToBestFile(baseFiles, markerFailureInlineRescueInput);
  assert(r5.appliedOps === 1, `marker failure + inline rescue: expected appliedOps=1, got ${r5.appliedOps}`);
  assert(r5.changedFiles.includes('App.tsx'), 'marker failure + inline rescue: expected App.tsx to change');
  assert(r5.files['App.tsx'].includes('const GRAVITY = 0.28;'), 'marker failure + inline rescue: gravity not updated');
};

const shouldTriggerSecondAttempt = ({ qualityMode, attemptIndex, isRepairCall, isIteration, hasHardIssues, hasRuntimeIssues, noEffectiveChanges, inlineNoOp }) => {
  if (isRepairCall) return false;
  if (attemptIndex >= 2) return false;
  if (qualityMode === 'single-pass') return false;
  if (qualityMode === 'always-best-of-2') return true;
  if (isIteration && attemptIndex === 1 && noEffectiveChanges) return true;
  return hasHardIssues || hasRuntimeIssues || noEffectiveChanges || inlineNoOp;
};

const orchestratorFixtures = () => {
  const a = shouldTriggerSecondAttempt({
    qualityMode: 'adaptive-best-of-2',
    attemptIndex: 1,
    isRepairCall: false,
    isIteration: false,
    hasHardIssues: true,
    hasRuntimeIssues: false,
    noEffectiveChanges: false,
    inlineNoOp: false
  });
  assert(a === true, 'orchestrator: adaptive mode should retry on hard issue');

  const b = shouldTriggerSecondAttempt({
    qualityMode: 'adaptive-best-of-2',
    attemptIndex: 1,
    isRepairCall: false,
    isIteration: false,
    hasHardIssues: false,
    hasRuntimeIssues: false,
    noEffectiveChanges: false,
    inlineNoOp: false
  });
  assert(b === false, 'orchestrator: adaptive mode should skip retry on healthy run');

  const c = shouldTriggerSecondAttempt({
    qualityMode: 'always-best-of-2',
    attemptIndex: 1,
    isRepairCall: false,
    isIteration: false,
    hasHardIssues: false,
    hasRuntimeIssues: false,
    noEffectiveChanges: false,
    inlineNoOp: false
  });
  assert(c === true, 'orchestrator: always-best-of-2 should always run second attempt');

  const d = shouldTriggerSecondAttempt({
    qualityMode: 'adaptive-best-of-2',
    attemptIndex: 1,
    isRepairCall: false,
    isIteration: true,
    hasHardIssues: false,
    hasRuntimeIssues: false,
    noEffectiveChanges: true,
    inlineNoOp: false
  });
  assert(d === true, 'orchestrator: iteration no-diff should force retry');
};

const runPreviewPreflightCompat = (files) => {
  const entryCandidates = [
    'index.tsx', 'index.jsx', 'main.tsx', 'main.jsx',
    'src/index.tsx', 'src/index.jsx', 'src/main.tsx', 'src/main.jsx'
  ];
  const entryFile = entryCandidates.find((name) => typeof files[name] === 'string' && files[name].trim().length > 0) || null;
  const fatalErrors = [];
  const warnings = [];
  const autoHealed = [];
  let syntheticIndexHtml = null;

  if (!entryFile) fatalErrors.push('No JS/TS entry file found (expected index/main in root or src).');
  const html = files['index.html'];
  if (!html) {
    syntheticIndexHtml = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';
    warnings.push('missing_index_html_auto_healed');
    autoHealed.push('index.html');
  } else if (!/id=["']root["']/.test(html)) {
    syntheticIndexHtml = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';
    warnings.push('missing_root_mount_auto_healed');
    autoHealed.push('index.html#root');
  }

  return {
    ok: fatalErrors.length === 0,
    fatalErrors,
    warnings,
    autoHealed,
    entryFile,
    syntheticIndexHtml
  };
};

const previewPreflightFixtures = () => {
  const caseA = runPreviewPreflightCompat({
    'index.tsx': "import App from './App';",
    'App.tsx': 'export default function App(){ return null; }'
  });
  assert(caseA.ok === true, 'preflight case A should be non-fatal');
  assert(caseA.warnings.includes('missing_index_html_auto_healed'), 'preflight case A should auto-heal missing index.html');

  const caseB = runPreviewPreflightCompat({
    'index.html': '<!DOCTYPE html><html><body><main>no root</main></body></html>',
    'index.tsx': "import App from './App';",
    'App.tsx': 'export default function App(){ return null; }'
  });
  assert(caseB.ok === true, 'preflight case B should be non-fatal');
  assert(caseB.warnings.includes('missing_root_mount_auto_healed'), 'preflight case B should auto-heal root mount');

  const caseC = runPreviewPreflightCompat({
    'index.html': '<!DOCTYPE html><html><body><div id="root"></div></body></html>'
  });
  assert(caseC.ok === false, 'preflight case C should be fatal');
  assert(caseC.fatalErrors.length > 0, 'preflight case C should report fatal errors');

  const caseD = runPreviewPreflightCompat({
    'src/main.tsx': "import App from './App';",
    'src/App.tsx': 'export default function App(){ return null; }'
  });
  assert(caseD.ok === true, 'preflight case D should be non-fatal with src/main.tsx');
  assert(caseD.entryFile === 'src/main.tsx', 'preflight case D should resolve src/main.tsx');
};

try {
  normalizationFixtures.forEach(runNormalizationFixture);
  inlinePatchFixtures();
  orchestratorFixtures();
  previewPreflightFixtures();
  console.log(`Parser regression suite passed (${normalizationFixtures.length + 12} fixtures).`);
  process.exit(0);
} catch (error) {
  console.error(`Parser regression suite failed: ${error.message}`);
  process.exit(1);
}
