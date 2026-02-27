/* eslint-disable no-console */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const consumeOllamaNdjson = (chunks) => {
  let buffer = '';
  let fullContent = '';
  let done = false;

  const processBuffer = (text) => {
    const lines = text.split('\n');
    const leftover = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.message?.content === 'string') {
        fullContent += parsed.message.content;
      }
      if (parsed?.done === true) {
        done = true;
      }
    }
    return leftover;
  };

  for (const chunk of chunks) {
    buffer += chunk;
    buffer = processBuffer(buffer);
    if (done) break;
  }
  if (buffer.trim()) processBuffer(`${buffer}\n`);

  return { fullContent, done };
};

const chunks = [
  '{"model":"qwen","message":{"role":"assistant","content":"<replace>"},"done":false}\n',
  '{"model":"qwen","message":{"role":"assistant","content":"\\n<find>a</find>"},"done":false}\n',
  '{"model":"qwen","message":{"role":"assistant","content":"\\n<with>b</with>\\n</replace>"},"done":false}\n',
  '{"model":"qwen","done":true}\n'
];

const result = consumeOllamaNdjson(chunks);
assert(result.done === true, 'done flag should be true');
assert(
  result.fullContent === '<replace>\n<find>a</find>\n<with>b</with>\n</replace>',
  'content should be assembled in-order from NDJSON chunks'
);

console.log('Ollama stream regression suite passed.');
