/**
 * CI GATE (PRD-07 §4 AC#1): every mounted route is rate-classified or explicitly exempt.
 *
 * ⚠️ DO NOT RUN YET. Importing ../src/app.js starts the HTTP server as a side effect
 * (app.listen at module load). This suite is written now but only passes AFTER Wave 2's
 * integrator guards `listen`/scheduler behind `NODE_ENV !== "test"` and adds NODE_ENV=test
 * to the test script. Until then it hangs the runner — it is intentionally not wired into
 * this agent's test run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { classifyRoute } from "../src/modules/ratelimit/routeClasses.js";

test("every mounted route is rate-classified or exempt", () => {
  // Express 5 exposes the router at app.router (app._router on older lines) — walk its stack.
  const stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> =
    (app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } }).router?.stack
    ?? (app as unknown as { _router?: { stack: unknown[] } })._router?.stack
    ?? ([] as never[]);

  const unclassified: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue; // middleware (json/clerk/app-gate/error handler) — not a route
    for (const method of Object.keys(layer.route.methods)) {
      const sig = `${method.toUpperCase()} ${layer.route.path}`;
      if (classifyRoute(method, layer.route.path) === null) unclassified.push(sig);
    }
  }
  assert.deepEqual(unclassified, [], `unclassified routes (add to routeClasses.ts): ${unclassified.join(", ")}`);
});
