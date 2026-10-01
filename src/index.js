/**
 * JSON Log — emit log lines as JSON objects with deterministic key order.
 *
 * @public
 * @module json-log
 */

import { JsonLogger } from "./core.js";

/**
 * Default singleton logger that writes to stdout. Provided as a convenience so
 * callers can import and immediately use it without configuration; it uses the
 * same clock (Date.now) and writer (process.stdout) that the class uses by
 * default, so replacing either is simply a matter of constructing your own.
 *
 * @public
 * @type {JsonLogger}
 */
const log = new JsonLogger();

export { JsonLogger };
export default log;
