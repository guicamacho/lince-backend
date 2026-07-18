/**
 * Entry side-effects: the guarded listen + the in-process drain scheduler. app.ts calls
 * startServer(app) only outside NODE_ENV=test, so importing `app` in tests (routeClassRegistry
 * walks the router) neither binds a port nor starts the drain.
 */
import type { Express } from "express";
import { env } from "./config/env.js";
import { drainWebhooks } from "./modules/webhooks/processor.js";
import { drainOutboxOnce } from "./modules/notifications/outbox.js";
import { reconcileInFlightTickets } from "./modules/money/moneyLoop.js";
import { aveniaFromEnv } from "./modules/providers/avenia/avenia.client.js";
import { alertSlaBreachesOnce } from "./modules/admin/aging.js";
import { runLifecycleSweep } from "./modules/lifecycle/closure.service.js";
import { runReconOnce } from "./modules/ledger/recon.js";

const DRAIN_INTERVAL_MS = Number(process.env.DRAIN_INTERVAL_MS ?? 5000);

export function startServer(app: Express): void {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`lince-phase1 listening on :${port} — Avenia ${env.avenia.baseUrl}`));
  // Single in-process scheduler drains both outboxes. Both claims use FOR UPDATE SKIP LOCKED,
  // so a second machine is safe (wasteful, not wrong). One tick failing is logged, not fatal.
  const notifyConfig = {
    emailAdapter: env.notify.emailAdapter,
    resendApiKey: env.notify.resendApiKey,
    from: env.notify.from,
    replyTo: env.notify.replyTo,
    slackWebhookUrl: env.notify.slackWebhookUrl,
    appBaseUrl: env.notify.appBaseUrl,
  };
  // Single-flight: skip a tick if the previous one is still running, so a slow DB can't
  // pile up overlapping drains and exhaust the connection pool.
  let draining = false;
  let tick = 0;
  setInterval(() => {
    if (draining) return;
    draining = true;
    tick++;
    void (async () => {
      try {
        await drainWebhooks();
        await drainOutboxOnce(notifyConfig);
        // Ticket reconcile backstop every ~12th tick (~60s at the 5s drain cadence):
        // webhooks win when flowing; this catches missed deliveries — and is the ONLY
        // settle path in local dev, where webhooks point at the deployed endpoint.
        const avenia = aveniaFromEnv();
        if (avenia && tick % 12 === 0) await reconcileInFlightTickets(avenia);
        // Admission-SLA sweep: shortly after boot, then hourly (720 ticks at 5s). The
        // exists-dedupe inside makes any cadence safe.
        if (tick === 1 || tick % 720 === 0) {
          await alertSlaBreachesOnce(env.sla.admissionDays);
          await runLifecycleSweep(); // stale warnings/expiry, dormancy, retention, rate_limits GC
          if (avenia) await runReconOnce(avenia); // ledger-vs-Avenia comparator (Cluster 4)
        }
      } catch (err) {
        console.warn("drain.tick_failed", err instanceof Error ? err.message : String(err));
      } finally {
        draining = false;
      }
    })();
  }, DRAIN_INTERVAL_MS);
}
