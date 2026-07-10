/**
 * Error-handler neutrality: framework errors (body-parser http-errors carry `statusCode`
 * just like HttpError) must keep their status but NEVER echo the raw message — only
 * HttpError's curated codes go to the client (verification sweep, 2026-07-11).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { pool } from "../src/db/pool.js";

after(() => pool.end());

test("malformed JSON -> neutral 400, never the parser message", async () => {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/didit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad_request" }); // not "Unexpected token ..."
  } finally {
    server.close();
  }
});
