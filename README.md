# JSON Log

Write log lines as JSON objects with a fixed key order: `level`, `time`, `msg`, then any caller-provided fields. One object per line, newline-terminated, ready for any line-oriented log processor.

```js
import log, { JsonLogger } from "json-log";

log.info("request handled", { requestId: "r-1", status: 200 });
// => {"level":"info","time":1717000000000,"msg":"request handled","requestId":"r-1","status":200}

// Construct your own to control the sink and clock (useful for tests):
const logger = new JsonLogger({ out: process.stdout, clock: () => Date.now() });
logger.warn("slow query", { durationMs: 1200 });
```

Exports: `JsonLogger` (class) and a default singleton `log` that writes to `process.stdout` using `Date.now`. The class constructor accepts `{ out, clock }`; `out` is any object with a `write(chunk)` method, `clock` is a function returning a millisecond timestamp. Methods: `log(level, msg, ...ctxs)`, plus `debug`, `info`, `warn`, `error` shortcuts.

## Why

The specific problem this solves is inconsistent key ordering in structured logs. When different call sites attach fields in different orders, two otherwise-identical records produce different JSON strings, which makes log streams harder to scan and breaks naive diffing. By fixing `level`, `time`, `msg` at the front and appending caller fields in first-seen order, every record from a given code path looks the same.

The trade-off: we rely on `JSON.stringify`'s insertion-order property rather than writing a custom serializer. That keeps the library tiny and lets nested objects serialise normally, but it means the ordering guarantee is about the *top-level* keys only — nested objects follow their own key order. If you need fully ordered nested data, serialise it yourself before passing it in.

## Awkward edge

Context values that `JSON.stringify` cannot handle — circular references, functions, symbols wrapped in objects — would normally throw and kill the logger. This library catches that failure, stringifies the offending value as a fallback, and ships the record anyway. The record still goes out, but the field will contain a string like `"[object Object]"` rather than the original structure. If you see that in your logs, the value you passed was not JSON-serialisable; pass a plain serialisable representation instead.
