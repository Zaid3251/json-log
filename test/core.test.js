import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonLogger } from "../src/core.js";
import log from "../src/index.js";

/**
 * A tiny in-memory sink that records every chunk written to it as a string in
 * an array. This lets the tests read back exactly what the logger produced
 * without touching real stdout. We deliberately collect strings (not buffers)
 * because the logger always writes strings.
 */
function makeBuffer() {
  const chunks = [];
  return {
    chunks,
    out: {
      write(chunk) {
        chunks.push(String(chunk));
      },
    },
  };
}

/**
 * Fixed clock returning a constant timestamp. The brief forbids asserting on
 * wall-clock time, so every test injects one of these.
 */
function fixedClock(t) {
  return () => t;
}

test("default export is a JsonLogger instance", () => {
  assert.ok(log instanceof JsonLogger);
});

test("writes a single JSON line terminated by a newline", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(1000) });
  logger.info("hello");
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /\n$/);
  const obj = JSON.parse(chunks[0]);
  assert.deepEqual(obj, { level: "info", time: 1000, msg: "hello" });
});

test("keys appear in the fixed order level, time, msg", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(7) });
  logger.info("hi", { requestId: "abc", userId: 42 });
  // JSON.stringify preserves insertion order for string keys, so the raw
  // text is the contract we care about here, not the parsed object.
  const text = chunks[0].trim();
  const keys = Object.keys(JSON.parse(text));
  assert.deepEqual(keys, ["level", "time", "msg", "requestId", "userId"]);
});

test("level is normalised to lowercase", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.log("INFO", "x");
  assert.equal(JSON.parse(chunks[0]).level, "info");
});

test("unknown level falls back to info", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.log("critical", "x");
  assert.equal(JSON.parse(chunks[0]).level, "info");
});

test("object message is JSON-stringified into msg", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.info({ code: 42, detail: "boom" });
  const obj = JSON.parse(chunks[0]);
  assert.equal(typeof obj.msg, "string");
  assert.deepEqual(JSON.parse(obj.msg), { code: 42, detail: "boom" });
});

test("null and undefined messages become empty string", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.info(null);
  logger.info(undefined);
  assert.equal(JSON.parse(chunks[0]).msg, "");
  assert.equal(JSON.parse(chunks[1]).msg, "");
});

test("bigint message is stringified", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.info(9007199254740993n);
  assert.equal(JSON.parse(chunks[0]).msg, "9007199254740993");
});

test("multiple context objects merge last-wins", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.info("x", { a: 1, b: 2 }, { b: 3, c: 4 });
  const obj = JSON.parse(chunks[0]);
  assert.equal(obj.a, 1);
  assert.equal(obj.b, 3);
  assert.equal(obj.c, 4);
});

test("context keys do not clobber the fixed schema", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(123) });
  logger.info("real msg", { level: "debug", time: 999, msg: "fake" });
  const obj = JSON.parse(chunks[0]);
  assert.equal(obj.level, "info");
  assert.equal(obj.time, 123);
  assert.equal(obj.msg, "real msg");
});

test("non-object context values are ignored", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.info("x", null, undefined, "str", 42, [1, 2]);
  const obj = JSON.parse(chunks[0]);
  assert.deepEqual(Object.keys(obj), ["level", "time", "msg"]);
});

test("circular context value is stringified, not thrown", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  const circ = { name: "loop" };
  circ.self = circ;
  // This must not throw; the fallback path converts the offending value to a
  // string so the record still ships.
  assert.doesNotThrow(() => logger.info("x", { bad: circ }));
  const obj = JSON.parse(chunks[0]);
  assert.equal(obj.level, "info");
  assert.equal(obj.msg, "x");
  assert.equal(typeof obj.bad, "string");
});

test("debug, warn, error shortcuts produce the right level", () => {
  const { chunks, out } = makeBuffer();
  const logger = new JsonLogger({ out, clock: fixedClock(0) });
  logger.debug("d");
  logger.warn("w");
  logger.error("e");
  assert.equal(JSON.parse(chunks[0]).level, "debug");
  assert.equal(JSON.parse(chunks[1]).level, "warn");
  assert.equal(JSON.parse(chunks[2]).level, "error");
});

test("uses process.stdout by default and does not throw", () => {
  // We don't read process.stdout back; we only assert that constructing
  // without options and logging does not throw. This guards the default-sink
  // branch in the constructor.
  assert.doesNotThrow(() => log.info("default sink smoke test"));
});
