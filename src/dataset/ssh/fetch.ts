// SSH dataset materialization: probe, initial meta/ mirror, and on-demand
// per-file fetch used by parquetReader / video resolver.
//
// The cache layout under context.globalStorage/ssh/<host>/<path-slug> is
// a literal mirror of the relevant subset of the remote dataset, so the
// rest of the extension treats SSH datasets exactly like local ones once
// files have been materialized.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as posix from "node:path/posix";
import type SftpClient from "ssh2-sftp-client";
import * as vscode from "vscode";
import { log, logError } from "../../log";
import type { DatasetDescriptor, SshTarget } from "../../types";
import { withSftp } from "./connection";

export function sshCacheRoot(context: vscode.ExtensionContext): string {
  return nodePath.join(context.globalStorageUri.fsPath, "ssh");
}

/** Per-target cache directory under sshCacheRoot. */
export function sshCacheDir(cacheRoot: string, target: SshTarget): string {
  return nodePath.join(cacheRoot, slug(target.host), slug(target.remotePath));
}

/** Stable DatasetDescriptor.id for an SSH target. Used for dedupe. */
export function sshDatasetId(target: SshTarget): string {
  return `ssh:${slug(target.host)}:${slug(target.remotePath)}`;
}

export async function probeRemoteDataset(
  target: SshTarget,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    return await withSftp(target, async (sftp) => {
      const stat = await sftp
        .stat(posix.join(target.remotePath, "meta", "info.json"))
        .catch(() => undefined);
      if (!stat || !stat.isFile) {
        return { ok: false, reason: `No meta/info.json at ${target.remotePath}` };
      }
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Initial fetch: pulls the remote `meta/` tree (info.json, stats.json,
 * tasks.*, episodes.*) into a local cache and returns a descriptor whose
 * `root` is the cache directory.
 */
export async function fetchSshDataset(
  target: SshTarget,
  cacheRoot: string,
  progress?: (msg: string) => void,
): Promise<DatasetDescriptor> {
  const cacheDir = sshCacheDir(cacheRoot, target);
  await fs.mkdir(cacheDir, { recursive: true });

  await withSftp(target, async (sftp) => {
    progress?.("Mirroring meta/ from remote…");
    await mirrorDir(
      sftp,
      posix.join(target.remotePath, "meta"),
      nodePath.join(cacheDir, "meta"),
      progress,
    );
  });

  const name = posix.basename(target.remotePath) || target.host;
  return {
    id: sshDatasetId(target),
    name,
    root: cacheDir,
    source: "ssh",
    ssh: target,
  };
}

/**
 * Download a single file (relative to the dataset root) on demand, no-op
 * if it's already cached. Used by parquetReader + video resolver.
 */
export async function ensureSshFile(
  descriptor: DatasetDescriptor,
  relativePath: string,
  progress?: (msg: string) => void,
): Promise<void> {
  if (descriptor.source !== "ssh" || !descriptor.ssh || !descriptor.root) return;
  const localPath = nodePath.join(descriptor.root, relativePath);
  try {
    await fs.access(localPath);
    return;
  } catch {
    // need to download
  }
  await fs.mkdir(nodePath.dirname(localPath), { recursive: true });
  await withSftp(descriptor.ssh, async (sftp) => {
    const remotePath = posix.join(descriptor.ssh!.remotePath, toPosix(relativePath));
    progress?.(`Downloading ${relativePath}`);
    log(`SSH fetch ${remotePath} → ${localPath}`);
    await sftp.fastGet(remotePath, localPath);
  });
}

async function mirrorDir(
  sftp: SftpClient,
  remoteDir: string,
  localDir: string,
  progress?: (msg: string) => void,
): Promise<void> {
  await fs.mkdir(localDir, { recursive: true });
  const entries = await sftp
    .list(remoteDir)
    .catch(() => [] as Awaited<ReturnType<SftpClient["list"]>>);
  for (const entry of entries) {
    const remotePath = posix.join(remoteDir, entry.name);
    const localPath = nodePath.join(localDir, entry.name);
    if (entry.type === "d") {
      await mirrorDir(sftp, remotePath, localPath, progress);
    } else if (entry.type === "-") {
      progress?.(
        `Downloading meta/${posix.relative(posix.join(remoteDir, ".."), remotePath)}`,
      );
      try {
        await sftp.fastGet(remotePath, localPath);
      } catch (err) {
        logError(`mirror ${remotePath}`, err);
      }
    }
  }
}

function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function toPosix(p: string): string {
  return p.split(nodePath.sep).join(posix.sep);
}
