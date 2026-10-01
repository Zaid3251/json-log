/**
 * Core implementation for JsonLogger.
 *
 * The central design choice is deterministic key ordering: every emitted
 * record is written with a fixed schema of keys (level, time, msg, then any
 * caller-provided fields in insertion order), regardless of how the fields
 * are supplied. Without this, downstream parsers see keys in arbitrary order
 * and lose the ability to eyeball a log stream and read the important bits
 * first. We achieve ordering by building the record in an array of [k, v]
 * pairs before serialising, rather than relying on object key iteration order
 * (which, while stable in modern engines for string keys, is a fragile
 * foundation for a contract and offers no lexicographic guarantee either).
 *
 * The only third-party-free way to control JSON key order in JavaScript is to
 * serialise the object ourselves. JSON.stringify uses insertion order of the
 * object's own enumerable string keys; for a plain object that means the order
 * we added the properties. That is sufficient here and avoids writing a
 * hand-rolled serializer that would have to handle nested structures, BigInt,
 * symbols, and the rest. So we build the record object by adding properties in
 * the desired order and then hand it to JSON.stringify. The only thing we
 * teach JSON.stringify not to do is prettify: every record is one line.
 *
 * @public
 * @module core
 */

/**
 * A writable byte stream used as the sink for log records. The real
 * process.stdout satisfies this, but tests pass in an in-memory buffer that
 * collects the written chunks. We deliberately type this in terms of the only
 * method we use, rather than pulling in Node's full Writable type, so the
 * library stays framework-agnostic and dependency-free.
 *
 * @typedef {Object} WritableSink
 * @property {(chunk: string | Uint8Array) => void} write
 */

/**
 * Function that returns a millisecond timestamp. Injected rather than read
 * from Date.now inside the logger so tests can pass a fixed clock and remain
 * deterministic. See the project's testing rules: never assert on wall-clock
 * time.
 *
 * @typedef {() => number} ClockFn
 */

/**
 * Map a symbolic level name to the canonical string written into the JSON
 * record. We normalise to lowercase so a caller writing "INFO" or "info" gets
 * the same output; mixing cases across a codebase is a common source of log
 * noise that downstream filters trip over. The set is deliberately small —
 * debug, info, warn, error — because the brief calls for a focused library,
 * not a twelve-level taxonomy.
 *
 * @param {string} level
 * @returns {string}
 */
function canonicalLevel(level) {
  const lower = String(level).toLowerCase();
  if (lower === "debug" || lower === "info" || lower === "warn" || lower === "error") {
    return lower;
  }
  // An unknown level is a caller bug, but silently swallowing it is worse
  // than recording it. We write "info" so the record still ships and the
  // message field carries what the caller tried to do.
  return "info";
}

/**
 * Coerce an arbitrary value into something JSON.stringify will accept as the
 * message string. Objects and arrays are stringified with JSON.stringify so a
 * caller passing structured data gets a readable representation rather than
 * "[object Object]". undefined becomes an empty string so the msg key is
 * always present in the output (a missing msg key breaks log readers that
 * assume its presence).
 *
 * @param {*} msg
 * @returns {string}
 */
function coerceMessage(msg) {
  if (msg === undefined || msg === null) {
    return "";
  }
  if (typeof msg === "string") {
    return msg;
  }
  if (typeof msg === "number" || typeof msg === "boolean" || typeof msg === "bigint") {
    return String(msg);
  }
  try {
    return JSON.stringify(msg);
  } catch {
    // Circular or otherwise unserialisable: fall back to String() so we never
    // throw from inside the logger. Throwing from a logger is the worst case.
    return String(msg);
  }
}

/**
 * Merge a sequence of context objects into a flat list of [key, value] pairs,
 * preserving insertion order and applying last-wins semantics for duplicate
 * keys across objects. We use a Map so the "last wins" behaviour is O(n) and
 * so the output order reflects the first time each key was seen, which is the
 * most predictable rule for a reader scanning a log line.
 *
 * @param {Array<Object<string, *>>} contexts
 * @returns {Array<[string, *]>}
 */
function mergeContexts(contexts) {
  const out = new Map();
  for (const ctx of contexts) {
    if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) {
      continue;
    }
    // We deliberately iterate own enumerable string keys only. Symbol keys
    // are invisible to JSON.stringify and would only confuse readers.
    for (const key of Object.keys(ctx)) {
      out.set(key, ctx[key]);
    }
  }
  return [...out];
}

/**
 * JsonLogger writes structured log records as single-line JSON.
 *
 * Each record has the fixed keys `level`, `time`, `msg` in that order,
 * followed by any caller-provided fields. Records are separated by newlines
 * so they can be consumed by any line-oriented log processor.
 */
class JsonLogger {
  /**
   * @param {Object} [opts]
   * @param {WritableSink} [opts.out] - Sink to write to. Defaults to
   *   process.stdout if available, otherwise a no-op sink so the logger can
   *   be instantiated in environments without a stdout (e.g. some bundlers).
   * @param {ClockFn} [opts.clock] - Returns the millisecond timestamp written
   *   into the `time` field. Defaults to Date.now. Inject a fake in tests.
   */
  constructor({ out, clock } = {}) {
    if (out) {
      this._out = out;
    } else if (typeof process !== "undefined" && process.stdout) {
      this._out = process.stdout;
    } else {
      // A no-op sink means the logger never throws in a bare environment.
      // This is preferable to failing at construction time.
      this._out = { write() {} };
    }
    this._clock = clock || (() => Date.now());
  }

  /**
   * Write a single log record.
   *
   * @param {string} level - One of debug, info, warn, error (case-insensitive).
   * @param {*} msg - Message value; objects are JSON-stringified.
   * @param {...Object<string, *>} ctxs - Optional context objects merged
   *   last-wins. Keys collide with the fixed schema, the schema wins.
   * @returns {void}
   */
  log(level, msg, ...ctxs) {
    const record = {};
    // Fixed schema first, in the exact order we want them to appear.
    record.level = canonicalLevel(level);
    record.time = this._clock();
    record.msg = coerceMessage(msg);
    // Caller fields after the schema. If a context provides a key that
    // clashes with the schema, we overwrite the caller's value with ours so
    // the contract (level/time/msg are always present and correctly typed)
    // holds.
    const merged = mergeContexts(ctxs);
    for (const [k, v] of merged) {
      record[k] = v;
    }
    // Re-assert the schema after merge so caller-provided keys cannot
    // clobber level/time/msg.
    record.level = canonicalLevel(level);
    record.time = this._clock();
    record.msg = coerceMessage(msg);
    // The second assignment to the same keys preserves their position in the
    // object's property list (engines do not reorder existing keys on
    // reassignment), so the output order remains level, time, msg, <caller>.
    let text;
    try {
      text = JSON.stringify(record);
    } catch (e) {
      // A caller-provided field value contains something JSON.stringify
      // cannot represent (a function, a circular reference, a Symbol value
      // wrapped in an object). We build a fallback record that strips the
      // offending value to a string and ship that instead of throwing.
      const safe = { level: record.level, time: record.time, msg: record.msg };
      for (const [k, v] of merged) {
        if (k === "level" || k === "time" || k === "msg") {
          continue;
        }
        try {
          JSON.stringify(v);
          safe[k] = v;
        } catch {
          safe[k] = String(v);
        }
      }
      text = JSON.stringify(safe);
    }
    this._out.write(text + "\n");
  }

  /**
   * Shortcut for log("debug", msg, ...ctxs).
   * @param {*} msg
   * @param {...Object<string, *>} ctxs
   * @returns {void}
   */
  debug(msg, ...ctxs) {
    this.log("debug", msg, ...ctxs);
  }

  /**
   * Shortcut for log("info", msg, ...ctxs).
   * @param {*} msg
   * @param {...Object<string, *>} ctxs
   * @returns {void}
   */
  info(msg, ...ctxs) {
    this.log("info", msg, ...ctxs);
  }

  /**
   * Shortcut for log("warn", msg, ...ctxs).
   * @param {*} msg
   * @param {...Object<string, *>} ctxs
   * @returns {void}
   */
  warn(msg, ...ctxs) {
    this.log("warn", msg, ...ctxs);
  }

  /**
   * Shortcut for log("error", msg, ...ctxs).
   * @param {*} msg
   * @param {...Object<string, *>} ctxs
   * @returns {void}
   */
  error(msg, ...ctxs) {
    this.log("error", msg, ...ctxs);
  }
}

export { JsonLogger };
