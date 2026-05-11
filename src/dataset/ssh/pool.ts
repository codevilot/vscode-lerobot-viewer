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
import * as vscode from "vscode";
import { log } from "../../log";
import type { SshTarget } from "../../types";
import { clearSessionPasswords, connectSilent, connectWithRetry } from "./connection";

export type SshConnectionState = "connected" | "connecting" | "disconnected";

interface PoolEntry {
  sftp: SftpClient;
  refs: number;
  dead: boolean;
  idleTimer?: NodeJS.Timeout;
}

const IDLE_TIMEOUT_MS = 5 * 60_000;

const pool = new Map<string, PoolEntry>();
const pending = new Map<string, Promise<PoolEntry>>();

// Targets that should stay connected as long as the user has the
// matching dataset registered in the extension. Pinned entries skip
// the idle timeout, and when their session dies the pool tries to
// silently rebuild it in the background so the next user action
// finds a ready connection. Stored as a Map (not just keys) so the
// lifecycle reconnect path has a SshTarget to feed to connectSilent.
const pinnedTargets = new Map<string, SshTarget>();

// In-flight silent warm-up acquires, keyed by pool key. Prevents
// stacking multiple background connect attempts for the same target
// (e.g., if the underlying session drops twice in quick succession).
const warmupInflight = new Set<string>();

// Reconnect delays for silent warm-up retries after a drop, in
// ascending order. The first delay is also used for the initial
// reconnect kicked off from the lifecycle close handler. Sum totals
// roughly 80 s of retry attempts before we give up and wait for the
// next user action.
const RECONNECT_BACKOFF_MS = [1500, 5000, 15000, 60000];

// Coalesced "something about the pool changed" event used by the
// tree view to refresh connection indicators on SSH dataset rows.
const poolChangeEmitter = new vscode.EventEmitter<void>();
export const onSshPoolChange = poolChangeEmitter.event;
let changeTimer: NodeJS.Timeout | undefined;
function fireChange(): void {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = undefined;
    poolChangeEmitter.fire();
  }, 80);
}

/** Snapshot of a target's connection state, used by the tree view. */
export function getSshConnectionState(target: SshTarget): SshConnectionState {
  const key = poolKey(target);
  const entry = pool.get(key);
  if (entry && !entry.dead) return "connected";
  if (pending.has(key) || warmupInflight.has(key)) return "connecting";
  return "disconnected";
}

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
      fireChange();
    }
    // If the dead session belonged to a registered dataset, silently
    // try to bring it back so the next user action doesn't have to
    // wait through a fresh connect. Subsequent failures inside
    // warmupTarget itself schedule their own backed-off retries.
    const target = pinnedTargets.get(key);
    if (target) {
      setTimeout(() => {
        if (!pinnedTargets.has(key)) return;     // unpinned during wait
        if (pool.has(key)) return;               // someone else reconnected
        void warmupTarget(target, 0);
      }, RECONNECT_BACKOFF_MS[0]);
    }
  };
  inner.on("close", () => kill("close"));
  inner.on("end", () => kill("end"));
  inner.on("error", (err) => kill(`error: ${err?.message ?? "unknown"}`));
}

/**
 * Open a connection in the background using only the auth methods
 * that don't require user interaction (ssh-agent, private key, or
 * the in-memory session-cached password). Used to warm up registered
 * SSH datasets on activate and to auto-reconnect after a drop. If
 * silent auth isn't possible we just give up — the next user action
 * triggers the regular interactive `withSftp` path which can prompt.
 */
async function warmupTarget(target: SshTarget, attempt = 0): Promise<void> {
  const key = poolKey(target);
  if (pool.has(key)) return;
  if (pending.has(key)) return;
  if (warmupInflight.has(key)) return;
  warmupInflight.add(key);
  fireChange();
  try {
    const sftp = await connectSilent(target);
    if (!sftp) {
      // Silent auth genuinely unavailable (no agent, no cached pw,
      // no usable key). No point retrying with backoff — the auth
      // situation won't change without a user action. Wait for the
      // next interactive acquire to prompt.
      log(`SSH pool: warmup skipped for ${key} (no silent auth available)`);
      return;
    }
    // Another acquire may have raced ahead while we were silent-
    // connecting. If so, drop our session and let theirs win.
    if (pool.has(key)) {
      await sftp.end().catch(() => {});
      return;
    }
    const entry: PoolEntry = { sftp, refs: 0, dead: false };
    attachLifecycle(key, entry);
    pool.set(key, entry);
    log(`SSH pool: warmed up ${key}`);
    fireChange();
  } catch (err) {
    // Network / timeout / dns. These are transient — schedule
    // another silent attempt with longer backoff, up to the cap.
    log(
      `SSH pool: warmup failed for ${key} (attempt ${attempt + 1}/${RECONNECT_BACKOFF_MS.length}): ${(err as Error).message}`,
    );
    const next = attempt + 1;
    if (pinnedTargets.has(key) && next < RECONNECT_BACKOFF_MS.length) {
      setTimeout(() => {
        if (!pinnedTargets.has(key)) return;
        if (pool.has(key)) return;
        void warmupTarget(target, next);
      }, RECONNECT_BACKOFF_MS[next]);
    }
  } finally {
    warmupInflight.delete(key);
    fireChange();
  }
}

async function acquire(target: SshTarget): Promise<PoolEntry> {
  const key = poolKey(target);

  const cached = pool.get(key);
  if (cached && !cached.dead) return cached;
  if (cached?.dead) pool.delete(key);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const next = (async () => {
    fireChange();  // moved into "connecting" state
    const sftp = await connectWithRetry(target);
    const entry: PoolEntry = { sftp, refs: 0, dead: false };
    attachLifecycle(key, entry);
    pool.set(key, entry);
    log(`SSH pool: opened ${key}`);
    fireChange();
    return entry;
  })();
  pending.set(key, next);
  try {
    return await next;
  } finally {
    pending.delete(key);
    fireChange();
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
    } else if (entry.refs === 0 && !pinnedTargets.has(key)) {
      scheduleIdleClose(key, entry);
    }
  }
}

/**
 * Replace the set of pinned SSH targets — sessions that should stay
 * connected as long as the matching dataset is registered. Newly
 * pinned targets get a fire-and-forget silent warm-up so the
 * connection is ready before the user first touches the dataset.
 * Unpinned targets revert to the usual 5-minute idle-close rule.
 * The call is idempotent: running it with the same set twice is a
 * no-op.
 */
export function setPinnedTargets(targets: SshTarget[]): void {
  const desired = new Map(targets.map((t) => [poolKey(t), t]));

  // Newly unpinned → if currently idle, schedule the idle close that
  // pinning was suppressing.
  for (const k of Array.from(pinnedTargets.keys())) {
    if (desired.has(k)) continue;
    pinnedTargets.delete(k);
    const entry = pool.get(k);
    if (entry && !entry.dead && entry.refs === 0 && !entry.idleTimer) {
      scheduleIdleClose(k, entry);
    }
  }

  // Newly pinned → cancel any pending idle close, then warm up in the
  // background. Already-known pins update their stored SshTarget in
  // case host / port / identityFile changed.
  for (const [k, target] of desired) {
    const wasNew = !pinnedTargets.has(k);
    pinnedTargets.set(k, target);
    const entry = pool.get(k);
    if (entry?.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (wasNew && !pool.has(k)) {
      void warmupTarget(target);
    }
  }
}

export async function disposeSshPool(): Promise<void> {
  const entries = Array.from(pool.values());
  pool.clear();
  pinnedTargets.clear();
  warmupInflight.clear();
  clearSessionPasswords();
  for (const e of entries) {
    if (e.idleTimer) {
      clearTimeout(e.idleTimer);
      e.idleTimer = undefined;
    }
    e.dead = true;
  }
  await Promise.allSettled(entries.map((e) => e.sftp.end()));
}
