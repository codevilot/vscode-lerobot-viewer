// Interactive remote folder browser. Opens a single SFTP session and
// walks the user through directories with QuickPick — they can navigate
// up/down, confirm the current folder, or fall back to typing a path
// manually. The current folder gets a "looks like a LeRobot dataset"
// hint when it already contains meta/info.json.
//
// The session is borrowed from the SSH pool, so the same connection
// also serves the probe + initial fetch that run right after the user
// picks a folder — no second password prompt.

import * as posix from "node:path/posix";
import type SftpClient from "ssh2-sftp-client";
import * as vscode from "vscode";
import type { SshTarget } from "../../types";
import { withSftp } from "./pool";

interface PickAction {
  kind: "navigate" | "select" | "manual" | "scan";
  path: string;
}

export async function pickRemoteFolder(
  target: Omit<SshTarget, "remotePath">,
): Promise<string | undefined> {
  // remotePath is a no-op for the pool key but required by SshTarget;
  // any placeholder works — operations explicitly pass absolute paths.
  return withSftp({ ...target, remotePath: "/" }, async (sftp) => {
    let cwd = await sftp.realPath(".").catch(() => "/");
    if (!cwd.startsWith("/")) cwd = "/" + cwd;

    while (true) {
      const action = await runFolderPicker(sftp, cwd);
      if (!action) return undefined;
      if (action.kind === "select") return action.path;
      if (action.kind === "scan") {
        const picked = await runScanFlow(sftp, action.path);
        if (picked) return picked;
        continue;
      }
      if (action.kind === "manual") {
        const manual = await vscode.window.showInputBox({
          title: "Enter remote path",
          value: action.path,
          ignoreFocusOut: true,
          validateInput: (v) =>
            v && v.startsWith("/") ? undefined : "Enter an absolute POSIX path",
        });
        if (manual) return manual.trim();
        continue;
      }
      cwd = action.path;
    }
  });
}

async function runFolderPicker(sftp: SftpClient, dir: string): Promise<PickAction | undefined> {
  const [isHere, entries] = await Promise.all([
    sftp
      .stat(posix.join(dir, "meta", "info.json"))
      .then(() => true)
      .catch(() => false),
    sftp.list(dir).catch(() => [] as Awaited<ReturnType<SftpClient["list"]>>),
  ]);

  type Item = vscode.QuickPickItem & { action: PickAction };
  const items: Item[] = [];

  if (dir !== "/") {
    items.push({
      label: "$(arrow-up) ..",
      description: posix.dirname(dir),
      action: { kind: "navigate", path: posix.dirname(dir) },
    });
  }

  items.push({
    label: isHere ? "$(check) Select this folder" : "$(folder-active) Select this folder",
    description: dir,
    detail: isHere
      ? "Contains meta/info.json — looks like a LeRobot dataset"
      : "No meta/info.json here. You can still select it if you know better.",
    action: { kind: "select", path: dir },
  });

  items.push({
    label: "$(edit) Enter path manually…",
    description: dir,
    action: { kind: "manual", path: dir },
  });

  items.push({
    label: "$(search) Scan for LeRobot datasets here…",
    description: dir,
    detail: `Recursively look for meta/info.json (depth ≤ ${SCAN_MAX_DEPTH})`,
    action: { kind: "scan", path: dir },
  });

  const folders = entries
    .filter((e) => e.type === "d" && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Cheap dataset-marker pre-scan: for the first ~50 children, check if
  // they are LeRobot dataset roots themselves. Bounded so listing huge
  // directories stays snappy.
  const sample = folders.slice(0, 50);
  const markers = await Promise.all(
    sample.map((f) =>
      sftp
        .stat(posix.join(dir, f.name, "meta", "info.json"))
        .then(() => true)
        .catch(() => false),
    ),
  );

  if (folders.length > 0) {
    items.push({
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
      action: { kind: "navigate", path: dir },
    });
  }
  folders.forEach((f, i) => {
    const isDataset = i < markers.length ? markers[i] : false;
    items.push({
      label: `${isDataset ? "$(database)" : "$(folder)"} ${f.name}`,
      description: isDataset ? "LeRobot dataset" : undefined,
      action: { kind: "navigate", path: posix.join(dir, f.name) },
    });
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: `Browse remote · ${dir}`,
    placeHolder: "Navigate, select this folder, or enter a path manually",
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.action;
}

// Bounded recursive search for LeRobot dataset roots (folders containing
// meta/info.json). Stays cheap by limiting depth, batching SFTP probes,
// skipping ignored/hidden dirs, capping result and total-visit counts,
// and honoring a vscode cancellation token.

const SCAN_MAX_DEPTH = 4;
const SCAN_CONCURRENCY = 12;
const SCAN_MAX_RESULTS = 100;
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

interface ScanProgress {
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

async function scanForDatasets(
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

async function runScanFlow(sftp: SftpClient, rootDir: string): Promise<string | undefined> {
  const datasets = await vscode.window.withProgress<string[]>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Scanning ${rootDir} for LeRobot datasets`,
      cancellable: true,
    },
    (progress, token) =>
      scanForDatasets(sftp, rootDir, token, (p) => {
        progress.report({
          message: `found ${p.found} · scanned ${p.scanned} · ${shortenForProgress(p.currentDir, rootDir)}`,
        });
      }),
  );

  if (datasets.length === 0) {
    void vscode.window.showInformationMessage(`No LeRobot datasets found under ${rootDir}.`);
    return undefined;
  }

  type Item = vscode.QuickPickItem & { path: string };
  const items: Item[] = datasets
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((p) => {
      const rel = posix.relative(rootDir, p);
      return {
        label: `$(database) ${posix.basename(p) || p}`,
        description: rel.length === 0 ? "(this folder)" : rel,
        detail: p,
        path: p,
      };
    });

  const hitCap = datasets.length >= SCAN_MAX_RESULTS;
  const title = hitCap
    ? `${datasets.length}+ datasets under ${rootDir} (result cap reached)`
    : `${datasets.length} dataset${datasets.length === 1 ? "" : "s"} under ${rootDir}`;

  const pick = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select a dataset, or press Escape to keep browsing",
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.path;
}

function shortenForProgress(full: string, root: string): string {
  const rel = posix.relative(root, full);
  const display = rel.length === 0 ? "." : rel;
  return display.length > 60 ? "…" + display.slice(-58) : display;
}
