// server.ts — the process that runs in production.
//
// ONE SERVICE, ONE JOB, since the pivot: serve the API and anchor what it has
// been given. The mirror worker that used to share this process is gone — see
// db/schema.sql for the arithmetic that killed it.
//
// NOT SERVERLESS, still. Every cold start would open a fresh Postgres
// connection and abandon it, and the anchor pass needs to hold one long enough
// to walk a day in batches. This is a container that stays up.
//
//   NOTARY_RUN_ANCHOR=0  serve without anchoring (roots still built on demand)
//   PORT                 provided by the platform
//
// Shutdown drains: SIGTERM stops anchoring, stops accepting connections, lets
// in-flight requests finish, then closes the pool. Railway and Fly both send
// SIGTERM and then wait, so a clean exit here means no half-written batch.

import { createServer } from 'node:http';
import { assertSchema, closePool } from './db.ts';
import { createApi } from './api.ts';
import { startAnchoring, signingStatus, type AnchorHandle } from './anchor.ts';

const PORT = Number(process.env.PORT ?? 8787);
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

  let leaving = false;
  const leave = async (signal: string): Promise<void> => {
    if (leaving) return;
    leaving = true;
    log(`${signal} — draining.`);

    anchoring?.stop();

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
