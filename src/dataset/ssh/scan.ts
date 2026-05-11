// Bounded BFS over a remote tree, looking for LeRobot dataset roots
// (folders containing meta/info.json).
//
// Used by the browse picker's explicit "Scan here" action and by the
// add-dataset wizard as an automatic fallback when the user picks a
// folder that isn't a dataset on its own. Stays cheap by limiting
// depth, batching SFTP probes, skipping noise/internal dirs, capping
// result + total-visit counts, and honoring a vscode cancellation
// token.

import * as posix from "node:path/posix";
import type SftpClient from "ssh2-sftp-client";
import * as vscode from "vscode";
import type { SshTarget } from "../../types";
import { withSftp } from "./pool";

export const SCAN_MAX_DEPTH = 4;
const SCAN_CONCURRENCY = 12;
export const SCAN_MAX_RESULTS = 100;
const SCAN_MAX_DIRS = 2000;

const IGNORED_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".vscode",
  "__pycache__",
  "venv",
  ".venv",
  "env",
  "dist",
  "build",
  "target",
  ".next",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
]);

// Names that are part of a LeRobot dataset's own internal layout. We
// skip these only when traversing INTO a folder we've already
// identified as a dataset, so we don't waste round trips on the
// hundreds of chunk subdirs under data/ and videos/. They're still
// followed at the user-chosen scan root, because someone might
// legitimately have a folder called e.g. ~/projects/data/ containing
// real datasets.
const DATASET_INTERNAL_DIRS = new Set(["data", "videos", "images", "meta"]);

export interface ScanProgress {
  scanned: number;
  found: number;
  currentDir: string;
}

interface ScanQueueItem {
  dir: string;
  /** True when this dir is a descendant of a folder we already flagged
   * as a dataset. Used to skip data/videos/images/meta further down. */
  insideDataset: boolean;
}

/** Run the BFS scan against an already-connected SFTP client. */
export async function scanForDatasets(
  sftp: SftpClient,
  rootDir: string,
  token: vscode.CancellationToken,
  onProgress: (p: ScanProgress) => void,
): Promise<string[]> {
  const found: string[] = [];
  let level: ScanQueueItem[] = [{ dir: rootDir, insideDataset: false }];
  let depth = 0;
  let scanned = 0;

  const shouldStop = (): boolean =>
    token.isCancellationRequested ||
    found.length >= SCAN_MAX_RESULTS ||
    scanned >= SCAN_MAX_DIRS;

  while (level.length > 0 && depth <= SCAN_MAX_DEPTH) {
    if (shouldStop()) break;

    const nextLevel: ScanQueueItem[] = [];

    for (let i = 0; i < level.length; i += SCAN_CONCURRENCY) {
      if (shouldStop()) break;
      const batch = level.slice(i, i + SCAN_CONCURRENCY);

      const probes = await Promise.all(
        batch.map(async (item) => {
          const [isDs, entries] = await Promise.all([
            sftp
              .stat(posix.join(item.dir, "meta", "info.json"))
              .then(() => true)
              .catch(() => false),
            sftp.list(item.dir).catch(() => [] as Awaited<ReturnType<SftpClient["list"]>>),
          ]);
          return { item, isDs, entries };
        }),
      );
      scanned += batch.length;

      for (const r of probes) {
        if (r.isDs && found.length < SCAN_MAX_RESULTS) found.push(r.item.dir);

        // Children inherit "inside a dataset" if this dir is one OR if
        // we were already inside one. That lets us keep recursing past
        // the dataset boundary to catch nested datasets (e.g. an
        // eval_subset/ inside a parent dataset) while still pruning
        // the dataset's own data/videos/meta chunks.
        const childInsideDataset = r.isDs || r.item.insideDataset;

        for (const e of r.entries) {
          if (e.type !== "d") continue;
          if (e.name.startsWith(".")) continue;
          if (IGNORED_SCAN_DIRS.has(e.name)) continue;
          if (childInsideDataset && DATASET_INTERNAL_DIRS.has(e.name)) continue;
          nextLevel.push({
            dir: posix.join(r.item.dir, e.name),
            insideDataset: childInsideDataset,
          });
        }
      }

      onProgress({
        scanned,
        found: found.length,
        currentDir: batch[batch.length - 1].dir,
      });
    }

    level = nextLevel;
    depth++;
  }

  return found;
}

/**
 * Open (or reuse) a pooled SFTP client to `target` and scan `rootDir`
 * for dataset roots. Convenience wrapper used by callers that don't
 * already hold an SFTP client.
 */
export async function findRemoteDatasets(
  target: SshTarget,
  rootDir: string,
  token: vscode.CancellationToken,
  onProgress: (p: ScanProgress) => void,
): Promise<string[]> {
  return withSftp(target, (sftp) => scanForDatasets(sftp, rootDir, token, onProgress));
}
