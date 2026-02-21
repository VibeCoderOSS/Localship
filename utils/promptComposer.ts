import { ComposedPromptResult, SimpleComposerDraft, SimpleComposerPayload } from '../types';

export const SIMPLE_NOTES_MAX_CHARS = 4000;

const trimField = (value?: string): string => (value || '').trim();

export const normalizeSimpleDraft = (draft: SimpleComposerDraft): SimpleComposerDraft => {
  const goal = trimField(draft.goal);
  const style = trimField(draft.style);
  const mustHave = trimField(draft.mustHave);
  const notesRaw = trimField(draft.notes);
  const notes = notesRaw.slice(0, SIMPLE_NOTES_MAX_CHARS);
  return {
    goal,
    style: style || undefined,
    mustHave: mustHave || undefined,
    notes: notes || undefined
  };
};

export const canSubmitSimpleDraft = (draft: SimpleComposerDraft): boolean => {
  return normalizeSimpleDraft(draft).goal.length > 0;
};

export const composeSimplePromptResult = (payload: SimpleComposerPayload): ComposedPromptResult => {
  const draft = normalizeSimpleDraft(payload);
  const mode = payload.mode;
  const lines: string[] = [];
  const omittedFields: Array<'style' | 'mustHave' | 'notes'> = [];

  if (mode === 'ask') {
    lines.push('TASK: ADVISE ONLY (NO FILE MUTATION)');
    lines.push(`Question: ${draft.goal}`);
    lines.push('Do not output patch blocks unless explicitly requested.');
    return {
      prompt: lines.join('\n'),
      omittedFields: ['style', 'mustHave', 'notes']
    };
  }

  if (mode === 'build') {
    lines.push('TASK: BUILD/EDIT APP');
    lines.push(`Goal: ${draft.goal}`);
  } else {
    lines.push('TASK: CHANGE/IMPROVE EXISTING APP');
    lines.push(`Change request: ${draft.goal}`);
  }

  if (draft.style) {
    lines.push(`Style: ${draft.style}`);
  } else {
    omittedFields.push('style');
  }

  if (draft.mustHave) {
    lines.push(`Must-have: ${draft.mustHave}`);
  } else {
    omittedFields.push('mustHave');
  }

  if (draft.notes) {
    lines.push(`Notes: ${draft.notes}`);
  } else {
    omittedFields.push('notes');
  }

  lines.push('Return valid marker blocks only.');

  return {
    prompt: lines.join('\n'),
    omittedFields
  };
};

export const composeSimplePrompt = (payload: SimpleComposerPayload): string => {
  return composeSimplePromptResult(payload).prompt;
};
