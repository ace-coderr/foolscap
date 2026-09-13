// server.ts — the process that runs in production.
//
// ONE SERVICE, TWO JOBS. The HTTP API and the mirror worker run in the same
// process because they want the same thing: a long-lived connection to
// Postgres. Splitting them would mean two pools, two idle connections against
// Supabase's limit, and two deployments to keep in step for no gain — the
// mirror is I/O-bound on long-polling Technocore and uses almost no CPU between
// batches.
//
// NOT SERVERLESS, and that is the point. Vercel functions are the wrong shape
// here twice over: the mirror has to hold a long-poll open for minutes at a
// time, and every cold start would open a fresh Postgres connection and
// abandon it. This is a container that stays up.
//
//   NOTARY_RUN_MIRROR=1  capture as well as serve (the production setting)
//   PORT                 provided by the platform
//
// Shutdown drains: SIGTERM stops the mirror, stops accepting connections, lets
// in-flight requests finish, then closes the pool. Railway and Fly both send
// SIGTERM and then wait, so a clean exit here means no half-written batch.

import { createServer } from 'node:http';
import { assertSchema, closePool } from './db.ts';
import { createApi } from './api.ts';
import { startMirror, type MirrorHandle } from './mirror.ts';
import { startAnchoring, signingStatus, type AnchorHandle } from './anchor.ts';

const PORT = Number(process.env.PORT ?? 8787);
const RUN_MIRROR = process.env.NOTARY_RUN_MIRROR === '1';
/** Anchoring is on unless switched off; an archive that never anchors is a database. */
const RUN_ANCHOR = process.env.NOTARY_RUN_ANCHOR !== '0';

/** How long in-flight requests get before the process leaves anyway. */
const DRAIN_MS = Number(process.env.NOTARY_DRAIN_MS ?? 10_000);

const log = (...parts: unknown[]): void => console.log(`[${new Date().toISOString()}]`, ...parts);

async function main(): Promise<void> {
  // Before anything binds a port: a service that answers /health while the
  // tables are missing is a service that reports itself healthy and then fails
  // every real request.
  await assertSchema();

  const handler = createApi();
  const server = createServer((req, res) => void handler(req, res));

  server.listen(PORT, () => log(`api listening on :${PORT}`));

  const signing = await signingStatus();
  log(
    signing.canSign
      ? `signing anchors as ${signing.did}`
      : `CANNOT sign anchors — ${signing.reason}. Roots will be built and served, not published.`
  );

  let anchoring: AnchorHandle | null = null;
  if (RUN_ANCHOR) anchoring = startAnchoring();

  let mirror: MirrorHandle | null = null;
  if (RUN_MIRROR) {
    // Started after the listener so the platform's health check passes while
    // the backfill — which takes minutes across a dozen rooms — is still
    // running. A service that only becomes reachable after the backfill would
    // be killed and restarted, and would lose the backfill each time.
    mirror = await startMirror();
    log(`mirror following ${mirror.rooms} room(s) in this process.`);
  } else {
    log('mirror not started (set NOTARY_RUN_MIRROR=1 to capture as well as serve).');
  }

  let leaving = false;
  const leave = async (signal: string): Promise<void> => {
    if (leaving) return;
    leaving = true;
    log(`${signal} — draining.`);

    // Mirror first: it is the thing holding open long-polls and writing
    // batches, and stopping it makes the rest quiet.
    anchoring?.stop();
    await mirror?.stop().catch((err) => log(`mirror stop failed: ${err.message}`));

    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MS).unref?.());
    await Promise.race([closed, timeout]);

    await closePool().catch(() => {});
    log('stopped.');
    process.exit(0);
  };

  process.on('SIGINT', () => void leave('SIGINT'));
  process.on('SIGTERM', () => void leave('SIGTERM'));
}

main().catch(async (err) => {
  console.error(`[fatal] ${err.stack ?? (err as Error).message}`);
  await closePool().catch(() => {});
  process.exit(1);
});
