/** PRD-09 phases 1–3: spread schedule (default/override/audit/cap) + pure application. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import {
  getEffectiveSpreads, setSpread, listSpreadConfig, applySpreads, MAX_SPREAD_BPS,
} from "../src/modules/money/fxSpreads.js";
import type { Rates } from "../src/modules/money/rates.service.js";
import { resetDb, createOrg, createAdmin } from "./helpers.js";

beforeEach(async () => {
  await resetDb();
  await pool.query("delete from fx_spreads");
});
after(() => pool.end());

test("default row applies to every org until an override exists; override wins; audit trail written", async () => {
  const admin = await createAdmin();
  const orgA = await createOrg("active");
  const orgB = await createOrg("active");

  await setSpread({ orgId: null, pair: "USD", direction: "buy", spreadBps: 50, adminId: admin });
  assert.equal((await getEffectiveSpreads(orgA)).USD.buy, 50);
  assert.equal((await getEffectiveSpreads(orgB)).USD.buy, 50);

  await setSpread({ orgId: orgA, pair: "USD", direction: "buy", spreadBps: 120, adminId: admin });
  assert.equal((await getEffectiveSpreads(orgA)).USD.buy, 120, "override wins");
  assert.equal((await getEffectiveSpreads(orgB)).USD.buy, 50, "other orgs keep the default");
  assert.equal((await getEffectiveSpreads(orgA)).EUR.sell, 0, "unset cells are 0");

  // clearing the override falls back to the default
  await setSpread({ orgId: orgA, pair: "USD", direction: "buy", spreadBps: null, adminId: admin });
  assert.equal((await getEffectiveSpreads(orgA)).USD.buy, 50);

  const audit = await pool.query<{ payload: { oldBps: number | null; newBps: number | null; scope: string } }>(
    "select payload from audit_log where event = 'admin.fx_spread_changed' order by created_at",
  );
  assert.equal(audit.rows.length, 3);
  assert.deepEqual(audit.rows[0]!.payload, { pair: "USD", direction: "buy", oldBps: null, newBps: 50, scope: "default" });
  assert.equal(audit.rows[1]!.payload.oldBps, null);
  assert.equal(audit.rows[1]!.payload.newBps, 120);
  assert.equal(audit.rows[2]!.payload.newBps, null, "clears are audited too");
});

test("guard rails: cap, bad pair/direction, default cannot be cleared", async () => {
  const admin = await createAdmin();
  await assert.rejects(
    setSpread({ orgId: null, pair: "USD", direction: "buy", spreadBps: MAX_SPREAD_BPS + 1, adminId: admin }),
    /invalid_spread_bps/,
  );
  await assert.rejects(setSpread({ orgId: null, pair: "GBP", direction: "buy", spreadBps: 10, adminId: admin }), /invalid_pair/);
  await assert.rejects(setSpread({ orgId: null, pair: "USD", direction: "mid", spreadBps: 10, adminId: admin }), /invalid_direction/);
  await assert.rejects(setSpread({ orgId: null, pair: "USD", direction: "buy", spreadBps: null, adminId: admin }), /cannot_clear_default/);
});

test("listSpreadConfig labels overrides with the org name", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  await setSpread({ orgId: null, pair: "EUR", direction: "buy", spreadBps: 30, adminId: admin });
  await setSpread({ orgId, pair: "EUR", direction: "buy", spreadBps: 80, adminId: admin });
  const rows = await listSpreadConfig();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.orgId, null);
  assert.equal(rows[1]!.razaoSocial, "Test Ltda");
});

test("applySpreads: buy worsens up, sell worsens down, mid untouched, nulls stay null", () => {
  const base: Rates = {
    brlUsd: { buy: 5.2, sell: 5.18, mid: 5.19 },
    brlEur: { buy: 6.1, mid: 6.05 },
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const out = applySpreads(base, { USD: { buy: 100, sell: 50 }, EUR: { buy: 0, sell: 0 } });
  assert.ok(Math.abs(out.brlUsd.buy! - 5.2 * 1.01) < 1e-9, "buy +100bps");
  assert.ok(Math.abs(out.brlUsd.sell! - 5.18 * 0.995) < 1e-9, "sell -50bps");
  assert.equal(out.brlUsd.mid, 5.19);
  assert.equal(out.brlEur.buy, 6.1, "0 bps = untouched");
  assert.equal(out.differentiated, true);

  const flat = applySpreads({ ...base, brlUsd: { buy: null, sell: null, mid: null } }, {
    USD: { buy: 100, sell: 100 }, EUR: { buy: 0, sell: 0 },
  });
  assert.equal(flat.brlUsd.buy, null, "null base stays null");

  const zero = applySpreads(base, { USD: { buy: 0, sell: 0 }, EUR: { buy: 0, sell: 0 } });
  assert.equal(zero.differentiated, false);
});
