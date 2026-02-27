/* eslint-disable no-console */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const buildOllamaRequestBody = (config, messages) => ({
  model: config.model,
  messages,
  stream: true,
  options: {
    num_ctx: clamp(Number(config.ollamaContextSize ?? 32000), 512, 262144)
  }
});

const bodyDefault = buildOllamaRequestBody(
  { model: 'qwen3-coder-next', ollamaContextSize: 32000 },
  [{ role: 'user', content: 'hi' }]
);
assert(bodyDefault.options.num_ctx === 32000, 'num_ctx should use configured value');

const bodyLow = buildOllamaRequestBody(
  { model: 'qwen3-coder-next', ollamaContextSize: 64 },
  [{ role: 'user', content: 'hi' }]
);
assert(bodyLow.options.num_ctx === 512, 'num_ctx should clamp to minimum');

const bodyHigh = buildOllamaRequestBody(
  { model: 'qwen3-coder-next', ollamaContextSize: 999999 },
  [{ role: 'user', content: 'hi' }]
);
assert(bodyHigh.options.num_ctx === 262144, 'num_ctx should clamp to maximum');

console.log('Ollama context regression suite passed.');
