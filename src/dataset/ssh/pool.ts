// SFTP client pool. Shares one live SSH session per (user@host:port,
// identityFile) across browse / probe / fetch / on-demand file
// downloads, so the user is prompted for credentials at most once per
// target until the connection idles out (default 5 minutes) or the
// server drops it.
//
// Lifecycle:
//   • acquire()  → returns a live PoolEntry, opening a new session if
//                  none is cached. Concurrent acquires for the same key
//                  share a single in-flight connect via `pending`.
//   • withSftp() → borrows an entry, bumps refs, runs the callback,
//                  releases. When refs returns to zero we schedule an
//                  idle close; another borrow before that fires cancels
//                  the timer.
//   • lifecycle  → close/end/error on the underlying ssh2 Client marks
//                  the entry dead and evicts it; the next acquire will
//                  reconnect transparently.

import type SftpClient from "ssh2-sftp-client";
import { log } from "../../log";
import type { SshTarget } from "../../types";
import { connectWithRetry } from "./connection";

interface PoolEntry {
  sftp: SftpClient;
  refs: number;
  dead: boolean;
  idleTimer?: NodeJS.Timeout;
}

const IDLE_TIMEOUT_MS = 5 * 60_000;

const pool = new Map<string, PoolEntry>();
const pending = new Map<string, Promise<PoolEntry>>();

function poolKey(t: SshTarget): string {
  return `${t.user ?? ""}@${t.host}:${t.port ?? 22}|${t.identityFile ?? ""}`;
}

function attachLifecycle(key: string, entry: PoolEntry): void {
  // ssh2-sftp-client wraps a node-ssh2 Client on `.client`; we listen on
  // the underlying client so we hear about TCP-level drops, not just the
  // SFTP channel.
  const inner = (entry.sftp as unknown as {
    client?: { on: (event: string, handler: (err?: Error) => void) => void };
  }).client;
  if (!inner) return;

  const kill = (reason: string) => {
    if (entry.dead) return;
    entry.dead = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (pool.get(key) === entry) {
      pool.delete(key);
      log(`SSH pool: evicted ${key} (${reason})`);
    }
  };
  inner.on("close", () => kill("close"));
  inner.on("end", () => kill("end"));
  inner.on("error", (err) => kill(`error: ${err?.message ?? "unknown"}`));
}

async function acquire(target: SshTarget): Promise<PoolEntry> {
  const key = poolKey(target);

  const cached = pool.get(key);
  if (cached && !cached.dead) return cached;
  if (cached?.dead) pool.delete(key);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const next = (async () => {
    const sftp = await connectWithRetry(target);
    const entry: PoolEntry = { sftp, refs: 0, dead: false };
    attachLifecycle(key, entry);
    pool.set(key, entry);
    log(`SSH pool: opened ${key}`);
    return entry;
  })();
  pending.set(key, next);
  try {
    return await next;
  } finally {
    pending.delete(key);
  }
}

function scheduleIdleClose(key: string, entry: PoolEntry): void {
  entry.idleTimer = setTimeout(() => {
    if (entry.refs !== 0 || entry.dead) return;
    if (pool.get(key) !== entry) return;
    pool.delete(key);
    log(`SSH pool: idle close ${key}`);
    void entry.sftp.end().catch(() => {});
  }, IDLE_TIMEOUT_MS);
  // Don't pin the event loop on the way out of activation.
  entry.idleTimer.unref?.();
}

function looksLikeConnectionLoss(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /not connected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|connection lost|channel open failure|no response from server|no sftp connection available/i.test(
    msg,
  );
}

export async function withSftp<T>(
  target: SshTarget,
  fn: (sftp: SftpClient) => Promise<T>,
): Promise<T> {
  const key = poolKey(target);
  const entry = await acquire(target);

  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  entry.refs++;

  try {
    return await fn(entry.sftp);
  } catch (err) {
    if (looksLikeConnectionLoss(err)) entry.dead = true;
    throw err;
  } finally {
    entry.refs--;
    if (entry.dead) {
      if (pool.get(key) === entry) pool.delete(key);
      if (entry.refs === 0) {
        void entry.sftp.end().catch(() => {});
      }
    } else if (entry.refs === 0) {
      scheduleIdleClose(key, entry);
    }
  }
}

export async function disposeSshPool(): Promise<void> {
  const entries = Array.from(pool.values());
  pool.clear();
  for (const e of entries) {
    if (e.idleTimer) {
      clearTimeout(e.idleTimer);
      e.idleTimer = undefined;
    }
    e.dead = true;
  }
  await Promise.allSettled(entries.map((e) => e.sftp.end()));
}
