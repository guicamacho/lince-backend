/** Delivery-gap poll against a fake rail client — a ticket with no stored event => one recon break. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool, withTransaction } from "../src/db/pool.js";
import { detectDeliveryGaps, type TicketLister } from "../src/modules/webhooks/gapPoll.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("a ticket with no matching webhook_event opens exactly one delivery_gap break", async () => {
  // 'tk-seen' was delivered; 'tk-missing' never arrived (the gap).
  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
       values ('avenia', 'tk-seen', 'ticket.updated', '{}')`,
  );
  const fake: TicketLister = {
    listTickets: async () => [
      { ticketId: "tk-seen", state: "PAID" },
      { ticketId: "tk-missing", state: "PROCESSING" },
    ],
  };

  const gaps = await withTransaction((c) => detectDeliveryGaps(c, fake, ["sub-1"], { asset: "BRL" }));
  assert.equal(gaps, 1);

  const { rows } = await pool.query<{ break_type: string; subaccount_id: string; asset: string; status: string }>(
    "select break_type, subaccount_id, asset, status from recon_breaks",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.break_type, "delivery_gap");
  assert.equal(rows[0]!.subaccount_id, "sub-1");
  assert.equal(rows[0]!.asset, "BRL");
  assert.equal(rows[0]!.status, "open");

  const runs = await pool.query<{ status: string }>("select status from recon_runs");
  assert.equal(runs.rows.length, 1);
  assert.equal(runs.rows[0]!.status, "completed");
});

test("no missing tickets => no breaks", async () => {
  const fake: TicketLister = { listTickets: async () => [] };
  const gaps = await withTransaction((c) => detectDeliveryGaps(c, fake, ["sub-1"]));
  assert.equal(gaps, 0);
  const { rowCount } = await pool.query("select 1 from recon_breaks");
  assert.equal(rowCount, 0);
});
