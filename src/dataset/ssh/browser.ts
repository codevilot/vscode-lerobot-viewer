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
import { SCAN_MAX_DEPTH, SCAN_MAX_RESULTS, scanForDatasets } from "./scan";

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
