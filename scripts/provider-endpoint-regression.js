/* eslint-disable no-console */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const normalizeOllamaChatEndpoint = (apiUrl) => {
  const input = stripTrailingSlash(apiUrl) || 'http://localhost:11434/api/chat';
  if (/\/api\/chat$/i.test(input)) return input;
  if (/\/api\/tags$/i.test(input)) return input.replace(/\/api\/tags$/i, '/api/chat');
  if (/\/v1\/chat\/completions$/i.test(input)) return input.replace(/\/v1\/chat\/completions$/i, '/api/chat');
  if (/\/v1\/models$/i.test(input)) return input.replace(/\/v1\/models$/i, '/api/chat');
  if (/\/v1$/i.test(input)) return input.replace(/\/v1$/i, '/api/chat');
  if (/\/chat\/completions$/i.test(input)) return input.replace(/\/chat\/completions$/i, '/api/chat');
  return `${input}/api/chat`;
};

const normalizeLmStudioChatEndpoint = (apiUrl) => {
  const input = stripTrailingSlash(apiUrl) || 'http://localhost:1234/v1/chat/completions';
  if (/\/v1\/chat\/completions$/i.test(input)) return input;
  if (/\/v1\/models$/i.test(input)) return input.replace(/\/v1\/models$/i, '/v1/chat/completions');
  if (/\/v1$/i.test(input)) return `${input}/chat/completions`;
  if (/\/chat\/completions$/i.test(input)) return input;
  return `${input}/v1/chat/completions`;
};

const resolveChatEndpoint = (apiUrl, apiProvider) => (
  apiProvider === 'ollama'
    ? normalizeOllamaChatEndpoint(apiUrl)
    : normalizeLmStudioChatEndpoint(apiUrl)
);

const resolveModelsEndpoint = (apiUrl, apiProvider) => {
  if (apiProvider === 'ollama') {
    const chat = normalizeOllamaChatEndpoint(apiUrl);
    return chat.replace(/\/api\/chat$/i, '/api/tags');
  }
  let modelsUrl = apiUrl;
  if (apiUrl.includes('/chat/completions')) modelsUrl = apiUrl.replace('/chat/completions', '/models');
  else if (apiUrl.includes('/v1')) modelsUrl = apiUrl.endsWith('/') ? `${apiUrl}models` : `${apiUrl}/models`;
  else modelsUrl = apiUrl.endsWith('/') ? `${apiUrl}v1/models` : `${apiUrl}/v1/models`;
  return modelsUrl;
};

const cases = [
  {
    name: 'lmstudio-default',
    provider: 'lmstudio',
    input: 'http://localhost:1234/v1/chat/completions',
    chat: 'http://localhost:1234/v1/chat/completions',
    models: 'http://localhost:1234/v1/models'
  },
  {
    name: 'lmstudio-base-v1',
    provider: 'lmstudio',
    input: 'http://localhost:1234/v1',
    chat: 'http://localhost:1234/v1/chat/completions',
    models: 'http://localhost:1234/v1/models'
  },
  {
    name: 'ollama-default',
    provider: 'ollama',
    input: 'http://localhost:11434/api/chat',
    chat: 'http://localhost:11434/api/chat',
    models: 'http://localhost:11434/api/tags'
  },
  {
    name: 'ollama-v1-fallback',
    provider: 'ollama',
    input: 'http://localhost:11434/v1/chat/completions',
    chat: 'http://localhost:11434/api/chat',
    models: 'http://localhost:11434/api/tags'
  }
];

cases.forEach((c) => {
  assert(resolveChatEndpoint(c.input, c.provider) === c.chat, `${c.name}: unexpected chat endpoint`);
  assert(resolveModelsEndpoint(c.input, c.provider) === c.models, `${c.name}: unexpected models endpoint`);
});

console.log('Provider endpoint regression suite passed.');
