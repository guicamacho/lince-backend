/**
 * Delivery-gap detection — the safety net for dropped webhooks.
 *
 * Polls the rail for tickets and, for any ticket we hold NO webhook_events row for, opens a
 * `recon_break` (break_type='delivery_gap') under a recon_run. This is how a missed/never-delivered
 * webhook surfaces instead of silently stalling a ticket.
 *
 * DORMANT this session: the Avenia client is a throwing stub (listTickets gated on the Wallets API),
 * so this runs against a fake in tests and goes live the day the client lands.
 * ponytail: matched on external_event_id = ticketId (Avenia's inbound id mapping is unconfirmed);
 * revisit the match key when the webhook payload shape is confirmed.
 */
import type pg from "pg";
import type { Ticket } from "../providers/provider.types.js";

/** Just the slice of RailProvider gap-detection needs — AveniaClient satisfies it structurally. */
export interface TicketLister {
  listTickets(input: { subAccountId: string }): Promise<Ticket[]>;
}

export async function detectDeliveryGaps(
  client: pg.PoolClient,
  provider: TicketLister,
  subAccountIds: string[],
  opts: { asset?: string } = {},
): Promise<number> {
  const run = await client.query<{ id: string }>(
    `insert into recon_runs (scope, status) values ('webhook_delivery_gap', 'running') returning id`,
  );
  const runId = run.rows[0]!.id;

  let gaps = 0;
  for (const subAccountId of subAccountIds) {
    const tickets = await provider.listTickets({ subAccountId });
    for (const ticket of tickets) {
      const seen = await client.query(
        `select 1 from webhook_events where provider_code = 'avenia' and external_event_id = $1 limit 1`,
        [ticket.ticketId],
      );
      if (seen.rowCount === 0) {
        await client.query(
          `insert into recon_breaks (run_id, subaccount_id, asset, break_type)
             values ($1, $2, $3, 'delivery_gap')`,
          [runId, subAccountId, opts.asset ?? null],
        );
        gaps++;
      }
    }
  }

  await client.query(`update recon_runs set status = 'completed', finished_at = now(), summary = $2 where id = $1`, [
    runId,
    JSON.stringify({ gaps }),
  ]);
  return gaps;
}
