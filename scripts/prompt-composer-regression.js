/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const TMP_OUT = '/tmp/localship-prompt-composer-test';
fs.rmSync(TMP_OUT, { recursive: true, force: true });
execSync(`npx tsc --module commonjs --target es2020 --esModuleInterop --skipLibCheck --outDir ${TMP_OUT} ${path.resolve(__dirname, '../utils/promptComposer.ts')} ${path.resolve(__dirname, '../types.ts')}`, { stdio: 'pipe' });
const { composeSimplePromptResult, canSubmitSimpleDraft, normalizeSimpleDraft, SIMPLE_NOTES_MAX_CHARS } = require(path.join(TMP_OUT, 'utils', 'promptComposer.js'));

const run = () => {
  const buildAll = composeSimplePromptResult({
    mode: 'build',
    goal: 'Create a dashboard',
    style: 'Minimal',
    mustHave: 'Tasks and charts',
    notes: 'Use clean spacing'
  });
  assert(buildAll.prompt.startsWith('TASK: BUILD/EDIT APP'), 'build header mismatch');
  assert(buildAll.prompt.includes('Goal: Create a dashboard'), 'goal line missing');
  assert(buildAll.prompt.includes('Style: Minimal'), 'style line missing');
  assert(buildAll.prompt.includes('Must-have: Tasks and charts'), 'must-have line missing');
  assert(buildAll.prompt.includes('Notes: Use clean spacing'), 'notes line missing');
  assert(buildAll.prompt.trim().endsWith('Return valid marker blocks only.'), 'build footer mismatch');

  const iterateGoalOnly = composeSimplePromptResult({
    mode: 'iterate',
    goal: 'Slow down bird falling speed',
    style: '',
    mustHave: '',
    notes: ''
  });
  assert(iterateGoalOnly.prompt.startsWith('TASK: CHANGE/IMPROVE EXISTING APP'), 'iterate header mismatch');
  assert(iterateGoalOnly.prompt.includes('Change request: Slow down bird falling speed'), 'iterate goal missing');
  assert(!iterateGoalOnly.prompt.includes('Style:'), 'empty style should be omitted');
  assert(!iterateGoalOnly.prompt.includes('Must-have:'), 'empty must-have should be omitted');
  assert(!iterateGoalOnly.prompt.includes('Notes:'), 'empty notes should be omitted');
  assert(iterateGoalOnly.prompt.trim().endsWith('Return valid marker blocks only.'), 'iterate footer mismatch');

  const askQuestion = composeSimplePromptResult({
    mode: 'ask',
    goal: 'Why is the preview failing?',
    style: '',
    mustHave: '',
    notes: ''
  });
  assert(askQuestion.prompt.startsWith('TASK: ADVISE ONLY (NO FILE MUTATION)'), 'ask header mismatch');
  assert(askQuestion.prompt.includes('Question: Why is the preview failing?'), 'ask question line missing');
  assert(!askQuestion.prompt.includes('Style:'), 'ask should not include style');
  assert(!askQuestion.prompt.includes('Must-have:'), 'ask should not include must-have');
  assert(!askQuestion.prompt.includes('Notes:'), 'ask should not include notes');
  assert(askQuestion.prompt.trim().endsWith('Do not output patch blocks unless explicitly requested.'), 'ask footer mismatch');

  const orderCheck = composeSimplePromptResult({
    mode: 'build',
    goal: 'A',
    notes: 'D',
    mustHave: 'C',
    style: 'B'
  }).prompt.split('\n');
  const idxGoal = orderCheck.findIndex((line) => line.startsWith('Goal:'));
  const idxStyle = orderCheck.findIndex((line) => line.startsWith('Style:'));
  const idxMust = orderCheck.findIndex((line) => line.startsWith('Must-have:'));
  const idxNotes = orderCheck.findIndex((line) => line.startsWith('Notes:'));
  assert(idxGoal < idxStyle && idxStyle < idxMust && idxMust < idxNotes, 'section order is unstable');

  assert(canSubmitSimpleDraft({ goal: 'x' }) === true, 'canSubmit should be true when goal exists');
  assert(canSubmitSimpleDraft({ goal: '   ' }) === false, 'canSubmit should be false for empty goal');

  const longNotes = 'n'.repeat(SIMPLE_NOTES_MAX_CHARS + 50);
  const normalized = normalizeSimpleDraft({
    goal: 'g',
    notes: longNotes
  });
  assert((normalized.notes || '').length === SIMPLE_NOTES_MAX_CHARS, 'notes soft cap not enforced');
};

run();
console.log('Prompt composer regression suite passed.');
