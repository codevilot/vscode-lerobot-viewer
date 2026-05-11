// Command IDs and registrations.
//
// Keeping all command wiring in one place makes contributions easy to audit
// against package.json and lets the tree provider, status bar, and command
// palette share a single source of truth.

import * as vscode from "vscode";
import type { DatasetService } from "./dataset/datasetService";
import type { DatasetTreeProvider, EpisodeNode, DatasetNode } from "./providers/datasetTreeProvider";
import type { EpisodePreviewPanelManager } from "./webview/episodePreviewPanel";
import type { MetadataViewerPanelManager } from "./webview/metadataViewerPanel";
import { isValidRepoId } from "./dataset/huggingface";
import {
  findRemoteDatasets,
  parseSshConfig,
  pickRemoteFolder,
  sshDatasetId,
} from "./dataset/ssh";
import * as posix from "node:path/posix";
import { launchRerun } from "./rerun/rerunLauncher";
import { log } from "./log";
import type { SshTarget } from "./types";

export const CommandIds = {
  openDataset: "lerobotViewer.openDataset",
  previewEpisode: "lerobotViewer.previewEpisode",
  openMetadata: "lerobotViewer.openMetadata",
  openInRerun: "lerobotViewer.openInRerun",
  addDatasetFolder: "lerobotViewer.addDatasetFolder",
  addHuggingFaceDataset: "lerobotViewer.addHuggingFaceDataset",
  addSshDataset: "lerobotViewer.addSshDataset",
  removeDataset: "lerobotViewer.removeDataset",
  refresh: "lerobotViewer.refresh",
  scanWorkspace: "lerobotViewer.scanWorkspace",
  revealInExplorer: "lerobotViewer.revealInExplorer",
  cleanSshCache: "lerobotViewer.cleanSshCache",
} as const;

interface PreviewArgs {
  datasetId: string;
  episodeIndex: number;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  service: DatasetService,
  previews: EpisodePreviewPanelManager,
  metadataViewer: MetadataViewerPanelManager,
  tree: DatasetTreeProvider,
): void {
  const reg = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  reg(CommandIds.openDataset, async () => {
    const result = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Open LeRobot dataset",
    });
    if (!result || result.length === 0) return;
    await service.addLocalFolder(result[0]);
  });

  reg(CommandIds.addDatasetFolder, async () => {
    await vscode.commands.executeCommand(CommandIds.openDataset);
  });

  reg(CommandIds.addHuggingFaceDataset, async () => {
    const repoId = await vscode.window.showInputBox({
      prompt: "Hugging Face dataset repo id",
      placeHolder: "e.g. lerobot/aloha_sim_insertion_human",
      validateInput: (input) =>
        input && !isValidRepoId(input.trim()) ? "Expected format: namespace/name" : undefined,
    });
    if (!repoId) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching ${repoId}` },
      async () => {
        await service.addHuggingFaceRepo(repoId.trim());
      },
    );
  });

  reg(CommandIds.addSshDataset, async () => {
    const targets = await runSshWizard();
    if (!targets || targets.length === 0) return;

    const existing = new Set(service.list().map((d) => d.id));
    let added = 0;
    let skipped = 0;
    for (const t of targets) {
      if (existing.has(sshDatasetId(t))) {
        skipped++;
        continue;
      }
      const desc = await service.addSshDataset(t);
      if (desc) {
        existing.add(desc.id);
        added++;
      }
    }
    if (added > 0) {
      const note =
        skipped > 0
          ? `Added ${added} SSH dataset${added === 1 ? "" : "s"} (${skipped} already registered)`
          : `Added ${added} SSH dataset${added === 1 ? "" : "s"}`;
      void vscode.window.showInformationMessage(note);
    }
  });

  reg(CommandIds.removeDataset, (...args: unknown[]) => {
    const node = args[0] as DatasetNode | undefined;
    if (!node || node.kind !== "dataset") return;
    service.remove(node.descriptor.id);
  });

  reg(CommandIds.refresh, () => {
    service.invalidate();
    tree.refresh();
  });

  reg(CommandIds.scanWorkspace, async () => {
    await service.scanWorkspace();
  });

  reg(CommandIds.cleanSshCache, async () => {
    const choice = await vscode.window.showWarningMessage(
      "Delete every cached SSH dataset file? Currently registered datasets will need to re-download their meta on next open.",
      { modal: true },
      "Delete cache",
    );
    if (choice !== "Delete cache") return;
    const { removed, total } = await service.cleanAllSshCaches();
    void vscode.window.showInformationMessage(
      total === 0
        ? "No SSH cache to clean."
        : `Cleaned ${removed}/${total} SSH cache director${total === 1 ? "y" : "ies"}.`,
    );
    tree.refresh();
  });

  reg(CommandIds.openMetadata, async (...args: unknown[]) => {
    const arg = args[0];
    let datasetId: string | undefined;
    if (isDatasetIdArg(arg)) datasetId = arg.datasetId;
    else if (isDatasetNode(arg)) datasetId = arg.descriptor.id;
    if (!datasetId) {
      const datasets = service.list();
      if (datasets.length === 0) {
        void vscode.window.showInformationMessage("No LeRobot datasets registered yet.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        datasets.map((d) => ({ label: d.name, description: d.source, id: d.id })),
        { placeHolder: "Pick a dataset" },
      );
      if (!pick) return;
      datasetId = pick.id;
    }
    await metadataViewer.show(datasetId);
  });

  reg(CommandIds.previewEpisode, async (...args: unknown[]) => {
    const arg = args[0];
    let payload: PreviewArgs | undefined;
    if (isPreviewArgs(arg)) {
      payload = arg;
    } else if (isEpisodeNode(arg)) {
      payload = { datasetId: arg.datasetId, episodeIndex: arg.episode.episodeIndex };
    }
    if (!payload) {
      payload = await pickEpisode(service);
    }
    if (!payload) return;
    await previews.show(payload.datasetId, payload.episodeIndex);
  });

  reg(CommandIds.openInRerun, async (...args: unknown[]) => {
    const arg = args[0];
    if (isEpisodeNode(arg)) {
      const snapshot = await service.getSnapshot(arg.datasetId);
      const episode = snapshot.episodes.find((e) => e.episodeIndex === arg.episode.episodeIndex);
      await launchRerun(snapshot, episode);
      return;
    }
    if (isDatasetNode(arg)) {
      const snapshot = await service.getSnapshot(arg.descriptor.id);
      await launchRerun(snapshot);
      return;
    }
    const fallback = await pickEpisode(service);
    if (!fallback) return;
    const snapshot = await service.getSnapshot(fallback.datasetId);
    const episode = snapshot.episodes.find((e) => e.episodeIndex === fallback.episodeIndex);
    await launchRerun(snapshot, episode);
  });

  reg(CommandIds.revealInExplorer, async (...args: unknown[]) => {
    const arg = args[0];
    if (isDatasetNode(arg) && arg.descriptor.root) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(arg.descriptor.root));
    }
  });

  log("Commands registered");
}

async function pickEpisode(service: DatasetService): Promise<PreviewArgs | undefined> {
  const datasets = service.list();
  if (datasets.length === 0) {
    void vscode.window.showInformationMessage("No LeRobot datasets registered yet.");
    return undefined;
  }
  const datasetPick = await vscode.window.showQuickPick(
    datasets.map((d) => ({ label: d.name, description: d.source, id: d.id })),
    { placeHolder: "Pick a dataset" },
  );
  if (!datasetPick) return undefined;
  const snapshot = await service.getSnapshot(datasetPick.id);
  if (snapshot.episodes.length === 0) {
    void vscode.window.showInformationMessage("Dataset has no episodes.");
    return undefined;
  }
  const episodePick = await vscode.window.showQuickPick(
    snapshot.episodes.map((e) => ({
      label: `Episode ${e.episodeIndex}`,
      description: `${e.length || "?"} frames${e.tasks.length ? ` · ${e.tasks[0]}` : ""}`,
      idx: e.episodeIndex,
    })),
    { placeHolder: "Pick an episode" },
  );
  if (!episodePick) return undefined;
  return { datasetId: datasetPick.id, episodeIndex: episodePick.idx };
}

async function runSshWizard(): Promise<SshTarget[] | undefined> {
  // Step 1: pick a host alias from ~/.ssh/config or enter manually.
  const aliases = await parseSshConfig();
  const ENTER = "$enter$";
  type HostPick = vscode.QuickPickItem & { value: string };
  const items: HostPick[] = aliases.map((a) => ({
    label: a.alias,
    description: `${a.user ? `${a.user}@` : ""}${a.hostName}${a.port ? `:${a.port}` : ""}`,
    detail: a.identityFile,
    value: a.alias,
  }));
  items.push({
    label: "$(edit) Enter host manually…",
    description: "user@host[:port]",
    value: ENTER,
  });
  const hostPick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select an SSH host (from ~/.ssh/config) or enter manually",
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!hostPick) return undefined;

  let target: Omit<SshTarget, "remotePath">;
  if (hostPick.value === ENTER) {
    const raw = await vscode.window.showInputBox({
      title: "SSH host",
      prompt: "Enter user@host[:port], or just host",
      placeHolder: "user@10.0.0.106",
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? undefined : "Required"),
    });
    if (!raw) return undefined;
    target = parseUserHostPort(raw.trim());
  } else {
    const alias = aliases.find((a) => a.alias === hostPick.value)!;
    target = {
      host: alias.hostName,
      user: alias.user,
      port: alias.port,
      identityFile: alias.identityFile,
      alias: alias.alias,
    };
  }

  // Step 2: open a remote folder browser. Connects once via SFTP and lets
  // the user navigate; they can also fall back to typing a path manually
  // from inside the picker if they already know it.
  const remotePath = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${target.user ? `${target.user}@` : ""}${target.host}…`,
    },
    () => pickRemoteFolder(target),
  );
  if (!remotePath) return undefined;

  // Step 3: scan from the picked path for every LeRobot dataset there.
  // We always scan (root is included), so a folder that is itself a
  // dataset still matches, and any nested datasets are picked up too.
  // No "this isn't a dataset" error — empty results just mean nothing
  // to add. Real connection errors (auth/network) still surface.
  const fullTarget: SshTarget = { ...target, remotePath: remotePath.trim() };
  const root = fullTarget.remotePath;
  let found: string[];
  try {
    found = await vscode.window.withProgress<string[]>(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Scanning ${root} for LeRobot datasets`,
        cancellable: true,
      },
      (progress, token) =>
        findRemoteDatasets(fullTarget, root, token, (p) =>
          progress.report({
            message: `found ${p.found} · scanned ${p.scanned} · ${shortenSshProgress(p.currentDir, root)}`,
          }),
        ),
    );
  } catch (err) {
    vscode.window.showErrorMessage(`SSH scan failed: ${(err as Error).message}`);
    return undefined;
  }

  return found.map((p) => ({ ...fullTarget, remotePath: p }));
}

function shortenSshProgress(full: string, root: string): string {
  const rel = posix.relative(root, full);
  const display = rel.length === 0 ? "." : rel;
  return display.length > 60 ? "…" + display.slice(-58) : display;
}

function parseUserHostPort(raw: string): Omit<SshTarget, "remotePath"> {
  let user: string | undefined;
  let host = raw;
  if (raw.includes("@")) {
    const [u, rest] = raw.split("@", 2);
    user = u;
    host = rest;
  }
  let port: number | undefined;
  if (host.includes(":")) {
    const [h, p] = host.split(":", 2);
    host = h;
    port = parseInt(p, 10);
    if (!Number.isFinite(port)) port = undefined;
  }
  return { host, user, port };
}

function isPreviewArgs(value: unknown): value is PreviewArgs {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as PreviewArgs).datasetId === "string" &&
    typeof (value as PreviewArgs).episodeIndex === "number"
  );
}

function isEpisodeNode(value: unknown): value is EpisodeNode {
  return !!value && typeof value === "object" && (value as { kind?: string }).kind === "episode";
}

function isDatasetNode(value: unknown): value is DatasetNode {
  return !!value && typeof value === "object" && (value as { kind?: string }).kind === "dataset";
}

function isDatasetIdArg(value: unknown): value is { datasetId: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { datasetId?: unknown }).datasetId === "string"
  );
}
