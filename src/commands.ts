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
  editTasks: "lerobotViewer.editTasks",
  editEpisodeTasks: "lerobotViewer.editEpisodeTasks",
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
  treeView: vscode.TreeView<unknown>,
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

  reg(CommandIds.editTasks, async (...args: unknown[]) => {
    const arg = args[0];
    const datasetId = isDatasetNode(arg) ? arg.descriptor.id : undefined;
    if (!datasetId) {
      void vscode.window.showInformationMessage("Use the context menu on a dataset to edit its tasks.");
      return;
    }
    await runTaskEditor(service, datasetId);
  });

  reg(CommandIds.editEpisodeTasks, async () => {
    // Use treeView.selection directly — this is the only reliable way to
    // get multi-selected items across all VS Code versions. Command args
    // from context menus vary in format (array vs spread vs nothing).
    const nodes = extractEpisodeNodesFromSelection(treeView.selection);
    if (nodes.length === 0) {
      void vscode.window.showInformationMessage("Select one or more episodes first.");
      return;
    }
    const datasetId = nodes[0].datasetId;
    const episodeIndices = nodes.map((n) => n.episode.episodeIndex);
    await runEpisodeTaskPicker(service, datasetId, episodeIndices);
  });

  reg(CommandIds.revealInExplorer, async (...args: unknown[]) => {
    const arg = args[0];
    if (isDatasetNode(arg) && arg.descriptor.root) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(arg.descriptor.root));
    }
  });

  log("Commands registered");
}

// ---- Task editor QuickPick flow ----

interface TaskPickItem extends vscode.QuickPickItem {
  actionKind: "action-add" | "task";
  taskName?: string;
  taskIndex?: number;
}

interface TaskActionItem extends vscode.QuickPickItem {
  actionKind: "action-rename" | "action-delete" | "action-back";
  taskName?: string;
}

async function runTaskEditor(service: DatasetService, datasetId: string): Promise<void> {
  const descriptor = service.get(datasetId);
  if (!descriptor) return;

  // Guard SSH / remote datasets early.
  if (descriptor.source === "ssh") {
    void vscode.window.showInformationMessage("Task editing is not supported for SSH datasets.");
    return;
  }

  try {
    const snapshot = await service.getSnapshot(datasetId);
    await showMainMenu(service, datasetId, snapshot.tasks);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not edit tasks: ${(err as Error).message}`);
  }
}

async function showMainMenu(service: DatasetService, datasetId: string, tasks: { taskIndex: number; task: string }[]): Promise<void> {
  const items: TaskPickItem[] = [
    {
      actionKind: "action-add",
      label: "$(add) Add Task",
      description: "Create a new task definition",
    },
  ];

  if (tasks.length > 0) {
    items.push({
      actionKind: "action-add",
      label: "",
      description: "",
      // Separator spacer — empty label hides line.
    } as TaskPickItem);
  }

  for (const t of tasks) {
    items.push({
      actionKind: "task",
      label: `[${t.taskIndex}] ${t.task}`,
      taskName: t.task,
      taskIndex: t.taskIndex,
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: tasks.length === 0 ? "No tasks defined. Use $(add) Add Task." : "Select a task to edit, or add a new one",
    matchOnDescription: false,
  });
  if (!pick) return;

  if (pick.actionKind === "action-add") {
    await runAddTask(service, datasetId, tasks);
    return;
  }

  if (pick.actionKind === "task" && pick.taskName) {
    await showTaskActions(service, datasetId, pick.taskName, tasks);
  }
}

async function showTaskActions(
  service: DatasetService,
  datasetId: string,
  taskName: string,
  tasks: { taskIndex: number; task: string }[],
): Promise<void> {
  const items: TaskActionItem[] = [
    { actionKind: "action-rename", label: `$(edit) Rename "${taskName}"`, taskName },
    { actionKind: "action-delete", label: `$(trash) Delete "${taskName}"`, taskName },
  ];

  // Only show back button if there are tasks to go back to.
  if (tasks.length > 0) {
    items.push({ actionKind: "action-back", label: "$(arrow-left) Back to task list" });
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Task: ${taskName}`,
  });
  if (!pick) return;

  if (pick.actionKind === "action-rename") {
    await runRenameTask(service, datasetId, taskName, tasks);
  } else if (pick.actionKind === "action-delete") {
    await runDeleteTask(service, datasetId, taskName);
  } else if (pick.actionKind === "action-back") {
    await showMainMenu(service, datasetId, tasks);
  }
}

async function runAddTask(
  service: DatasetService,
  datasetId: string,
  tasks: { taskIndex: number; task: string }[],
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: "New task name",
    placeHolder: "e.g. pick up the red cube",
    validateInput: (v) => {
      if (!v.trim()) return "Task name cannot be empty.";
      if (tasks.some((t) => t.task === v.trim())) return "A task with this name already exists.";
      return undefined;
    },
  });
  if (!name) return;

  try {
    await service.addTask(datasetId, name.trim());
    void vscode.window.showInformationMessage(`Task "${name.trim()}" added.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to add task: ${(err as Error).message}`);
    return;
  }

  // Refresh and show updated list.
  try {
    const refreshed = await service.getSnapshot(datasetId);
    await showMainMenu(service, datasetId, refreshed.tasks);
  } catch {
    // If refresh fails, just return.
  }
}

async function runRenameTask(
  service: DatasetService,
  datasetId: string,
  oldName: string,
  tasks: { taskIndex: number; task: string }[],
): Promise<void> {
  const newName = await vscode.window.showInputBox({
    prompt: `Rename task "${oldName}"`,
    value: oldName,
    placeHolder: "Enter new task name",
    validateInput: (v) => {
      if (!v.trim()) return "Task name cannot be empty.";
      if (v.trim() === oldName) return "Name is unchanged.";
      if (tasks.some((t) => t.task === v.trim())) return "A task with this name already exists.";
      return undefined;
    },
  });
  if (!newName) return;

  try {
    await service.renameTask(datasetId, oldName, newName.trim());
    void vscode.window.showInformationMessage(`Task renamed: "${oldName}" → "${newName.trim()}"`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to rename task: ${(err as Error).message}`);
    return;
  }

  try {
    const refreshed = await service.getSnapshot(datasetId);
    await showMainMenu(service, datasetId, refreshed.tasks);
  } catch {
    // ignore
  }
}

async function runDeleteTask(
  service: DatasetService,
  datasetId: string,
  taskName: string,
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Delete task "${taskName}"? This will also remove it from all episodes that reference it.`,
    { modal: true },
    "Delete",
  );
  if (confirm !== "Delete") return;

  try {
    await service.deleteTask(datasetId, taskName);
    void vscode.window.showInformationMessage(`Task "${taskName}" deleted.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to delete task: ${(err as Error).message}`);
    return;
  }

  try {
    const refreshed = await service.getSnapshot(datasetId);
    await showMainMenu(service, datasetId, refreshed.tasks);
  } catch {
    // ignore
  }
}

// ---- Episode task assignment ----

async function runEpisodeTaskPicker(
  service: DatasetService,
  datasetId: string,
  episodeIndices: number[],
): Promise<void> {
  const descriptor = service.get(datasetId);
  if (!descriptor) return;
  if (descriptor.source === "ssh") {
    void vscode.window.showInformationMessage("Task assignment is not supported for SSH datasets.");
    return;
  }

  let snapshot;
  try {
    snapshot = await service.getSnapshot(datasetId);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not load dataset: ${(err as Error).message}`);
    return;
  }

  const allTasks = snapshot.tasks;
  if (allTasks.length === 0) {
    const create = await vscode.window.showInformationMessage(
      "No tasks defined for this dataset. Create tasks first?",
      "Edit Tasks",
    );
    if (create === "Edit Tasks") {
      await vscode.commands.executeCommand(CommandIds.editTasks, { datasetId });
    }
    return;
  }

  // For multiple episodes, pre-select the intersection of all their tasks.
  // For a single episode, pre-select its current tasks.
  let commonTasks: Set<string>;
  if (episodeIndices.length === 1) {
    const ep = snapshot.episodes.find((e) => e.episodeIndex === episodeIndices[0]);
    commonTasks = new Set(ep?.tasks ?? []);
  } else {
    const taskSets = episodeIndices.map((idx) => {
      const ep = snapshot.episodes.find((e) => e.episodeIndex === idx);
      return new Set(ep?.tasks ?? []);
    });
    commonTasks = taskSets[0] ? new Set(taskSets[0]) : new Set<string>();
    for (let i = 1; i < taskSets.length; i++) {
      for (const t of commonTasks) {
        if (!taskSets[i].has(t)) commonTasks.delete(t);
      }
    }
  }

  const label = episodeIndices.length === 1
    ? `Episode ${episodeIndices[0]}`
    : `${episodeIndices.length} episodes`;

  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { taskName: string }>();
  qp.canSelectMany = true;
  qp.title = `${label} · Assign Tasks`;
  qp.placeholder = `Check tasks to assign${episodeIndices.length > 1 ? ` to ${episodeIndices.length} episodes` : ""}`;
  qp.matchOnDescription = false;
  qp.items = allTasks.map((t) => ({
    label: t.task,
    description: `[${t.taskIndex}]`,
    taskName: t.task,
    picked: commonTasks.has(t.task),
  }));

  const done = await new Promise<readonly { taskName: string }[] | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });

  if (!done) return;

  const newTasks = done.map((i) => i.taskName);
  try {
    for (const idx of episodeIndices) {
      await service.setEpisodeTasks(datasetId, idx, newTasks);
    }
    const suffix = newTasks.length === 0
      ? "all tasks removed"
      : `assigned to "${newTasks.join(", ")}"`;
    void vscode.window.showInformationMessage(
      episodeIndices.length === 1
        ? `Episode ${episodeIndices[0]}: ${suffix}.`
        : `${episodeIndices.length} episodes: ${suffix}.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to update episode tasks: ${(err as Error).message}`);
  }
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

/**
 * Extract EpisodeNode items from the tree view selection.
 * `treeView.selection` returns a readonly array of tree items — the
 * same objects returned by the TreeDataProvider.
 */
function extractEpisodeNodesFromSelection(selection: readonly unknown[]): EpisodeNode[] {
  const out: EpisodeNode[] = [];
  for (const item of selection) {
    if (isEpisodeNode(item)) out.push(item);
    // Also accept nodes wrapped in an array (defensive).
    if (Array.isArray(item)) {
      for (const sub of item) {
        if (isEpisodeNode(sub)) out.push(sub);
      }
    }
  }
  return out;
}
