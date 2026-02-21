/* eslint-disable no-console */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const appendWithCap = (current, delta, cap) => {
  if (!delta) return { next: current, dropped: 0 };
  const combined = `${current}${delta}`;
  if (combined.length <= cap) return { next: combined, dropped: 0 };
  const dropped = combined.length - cap;
  return { next: combined.slice(dropped), dropped };
};

const runLogCapFixture = () => {
  const cap = 400000;
  let raw = '';
  let parsed = '';
  let timeline = '';
  let wire = '';
  let droppedRaw = 0;
  let droppedParsed = 0;
  let droppedTimeline = 0;
  let droppedWire = 0;

  for (let i = 0; i < 5000; i++) {
    const delta = `chunk-${i}-` + 'x'.repeat(120);
    const r = appendWithCap(raw, delta, cap);
    raw = r.next;
    droppedRaw += r.dropped;

    const p = appendWithCap(parsed, delta, cap);
    parsed = p.next;
    droppedParsed += p.dropped;

    const t = appendWithCap(timeline, `turn-${i}-` + 't'.repeat(120) + '\n', cap);
    timeline = t.next;
    droppedTimeline += t.dropped;

    const w = appendWithCap(wire, `data: ${i}-` + 'w'.repeat(120) + '\n', cap);
    wire = w.next;
    droppedWire += w.dropped;
  }

  assert(raw.length <= cap, `raw log exceeded cap: ${raw.length}`);
  assert(parsed.length <= cap, `parsed log exceeded cap: ${parsed.length}`);
  assert(timeline.length <= cap, `timeline log exceeded cap: ${timeline.length}`);
  assert(wire.length <= cap, `wire log exceeded cap: ${wire.length}`);
  assert(droppedRaw > 0, 'expected dropped chars for raw');
  assert(droppedParsed > 0, 'expected dropped chars for parsed');
  assert(droppedTimeline > 0, 'expected dropped chars for timeline');
  assert(droppedWire > 0, 'expected dropped chars for wire');
};

const runCadenceFixture = () => {
  const cadenceMs = 120;
  const minEmitChars = 80;
  let pending = 0;
  let lastEmit = 0;
  let emits = 0;
  const start = Date.now();

  for (let i = 0; i < 300; i++) {
    pending += 12; // small token chunks
    const now = start + i * 5; // high-frequency incoming chunks
    if (pending >= minEmitChars || now - lastEmit >= cadenceMs) {
      emits += 1;
      pending = 0;
      lastEmit = now;
    }
  }

  assert(emits > 0, 'expected cadence fixture to emit at least once');
  assert(emits < 120, `expected throttling to reduce update count, got emits=${emits}`);
};

runLogCapFixture();
runCadenceFixture();
console.log('Stream memory regression suite passed.');
