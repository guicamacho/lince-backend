/**
 * CI GATE (PRD-07 §4 AC#1): every mounted route is rate-classified or explicitly exempt.
 * (app.listen/scheduler are guarded behind NODE_ENV !== "test", so importing app is safe.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { classifyRoute } from "../src/modules/ratelimit/routeClasses.js";

// The walk below only sees layer.route, which a mounted express.Router() does NOT populate —
// its nested routes would vanish from this gate and it would pass vacuously. The floor makes
// that failure loud: if a refactor moves routes into a mounted Router, the count collapses.
// Raise the floor when routes are added; never lower it to "fix" a collapse.
const ROUTE_COUNT_FLOOR = 45;

test("every mounted route is rate-classified or exempt", () => {
  // Express 5 exposes the router at app.router (app._router on older lines) — walk its stack.
  const stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> =
    (app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } }).router?.stack
    ?? (app as unknown as { _router?: { stack: unknown[] } })._router?.stack
    ?? ([] as never[]);

  const unclassified: string[] = [];
  let routeCount = 0;
  for (const layer of stack) {
    if (!layer.route) continue; // middleware (json/clerk/app-gate/error handler) — not a route
    for (const method of Object.keys(layer.route.methods)) {
      routeCount++;
      const sig = `${method.toUpperCase()} ${layer.route.path}`;
      if (classifyRoute(method, layer.route.path) === null) unclassified.push(sig);
    }
  }
  assert.deepEqual(unclassified, [], `unclassified routes (add to routeClasses.ts): ${unclassified.join(", ")}`);
  assert.ok(
    routeCount >= ROUTE_COUNT_FLOOR,
    `only ${routeCount} routes visible to the gate (floor ${ROUTE_COUNT_FLOOR}) — did a refactor mount an express.Router()?`,
  );
});
