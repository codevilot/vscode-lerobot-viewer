// Datasets sidebar tree.
//
// Top level: one node per registered dataset.
// Children:  fixed "Episodes" + "Cameras" group nodes, each lazily expanded.
// Filter:    the welcome view + sidebar header host the search/filter UI.

import * as vscode from "vscode";
import type { DatasetService } from "../dataset/datasetService";
import { getSshConnectionState, onSshPoolChange } from "../dataset/ssh";
import { log } from "../log";
import type {
  DatasetDescriptor,
  DatasetSnapshot,
  LeRobotEpisode,
} from "../types";

export type LeRobotTreeNode =
  | DatasetNode
  | LoadingNode
  | ErrorNode
  | GroupNode
  | EpisodeNode
  | MetadataLeafNode;

interface NodeBase {
  readonly kind: string;
}

export interface DatasetNode extends NodeBase {
  kind: "dataset";
  descriptor: DatasetDescriptor;
}
interface LoadingNode extends NodeBase {
  kind: "loading";
  parentId: string;
}
interface ErrorNode extends NodeBase {
  kind: "error";
  parentId: string;
  message: string;
}
interface GroupNode extends NodeBase {
  kind: "group";
  datasetId: string;
  groupId: "episodes";
  label: string;
}
export interface EpisodeNode extends NodeBase {
  kind: "episode";
  datasetId: string;
  episode: LeRobotEpisode;
  fps: number;
  taskMap?: Record<string, number>;
}
export interface MetadataLeafNode extends NodeBase {
  kind: "metadataLeaf";
  datasetId: string;
}

export class DatasetTreeProvider implements vscode.TreeDataProvider<LeRobotTreeNode>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<LeRobotTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private filter = "";
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly service: DatasetService) {
    this.disposables.push(this.service.onDidChange(() => this._onDidChange.fire(undefined)));
    // Refresh SSH dataset rows whenever a connection comes up / drops.
    this.disposables.push(onSshPoolChange(() => this._onDidChange.fire(undefined)));
  }

  setFilter(text: string): void {
    this.filter = text.toLowerCase();
    this._onDidChange.fire(undefined);
  }

  refresh(node?: LeRobotTreeNode): void {
    this._onDidChange.fire(node);
  }

  dispose(): void {
    this._onDidChange.dispose();
    for (const d of this.disposables) d.dispose();
  }

  getTreeItem(node: LeRobotTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "dataset":
        return datasetItem(node);
      case "group":
        return groupItem(node);
      case "episode":
        return episodeItem(node);
      case "metadataLeaf":
        return metadataLeafItem(node);
      case "loading":
        return new vscode.TreeItem("Loading…", vscode.TreeItemCollapsibleState.None);
      case "error": {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("error");
        return item;
      }
    }
  }

  async getChildren(node?: LeRobotTreeNode): Promise<LeRobotTreeNode[]> {
    if (!node) {
      return this.service.list().map((descriptor): DatasetNode => ({ kind: "dataset", descriptor }));
    }
    if (node.kind === "dataset") {
      return [
        { kind: "group", datasetId: node.descriptor.id, groupId: "episodes", label: "Episodes" },
        { kind: "metadataLeaf", datasetId: node.descriptor.id },
      ];
    }
    if (node.kind === "group") {
      try {
        const snapshot = await this.service.getSnapshot(node.datasetId);
        return this.episodeChildren(node.datasetId, snapshot);
      } catch (err) {
        log(`failed to load snapshot for ${node.datasetId}: ${(err as Error).message}`);
        return [{ kind: "error", parentId: node.datasetId, message: (err as Error).message }];
      }
    }
    return [];
  }

  private episodeChildren(datasetId: string, snapshot: DatasetSnapshot): EpisodeNode[] {
    const filter = this.filter;
    const taskMap: Record<string, number> = {};
    for (const t of snapshot.tasks) taskMap[t.task] = t.taskIndex;
    return snapshot.episodes
      .filter((ep) => {
        if (!filter) return true;
        if (String(ep.episodeIndex).includes(filter)) return true;
        return ep.tasks.some((t) => t.toLowerCase().includes(filter));
      })
      .map((episode) => ({ kind: "episode", datasetId, episode, fps: snapshot.info.fps, taskMap }));
  }
}

// ----- TreeItem factories -----

function datasetItem(node: DatasetNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.descriptor.name, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = node.descriptor.id;
  item.contextValue = "lerobotDataset";
  item.iconPath = sshIconFor(node.descriptor) ?? new vscode.ThemeIcon(iconForSource(node.descriptor.source));
  item.tooltip = sshTooltipFor(node.descriptor) ?? (
    node.descriptor.repoId
      ? `${node.descriptor.repoId} (Hugging Face)`
      : node.descriptor.root ?? node.descriptor.id
  );
  item.description = sourceDescription(node.descriptor);
  return item;
}

/**
 * For SSH datasets, replace the default "remote" icon with a colored
 * dot reflecting whether the underlying SFTP session is alive. Other
 * sources keep the default.
 */
function sshIconFor(d: DatasetDescriptor): vscode.ThemeIcon | undefined {
  if (d.source !== "ssh" || !d.ssh) return undefined;
  const state = getSshConnectionState(d.ssh);
  switch (state) {
    case "connected":
      return new vscode.ThemeIcon(
        "circle-filled",
        new vscode.ThemeColor("charts.green"),
      );
    case "connecting":
      return new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.yellow"),
      );
    case "disconnected":
    default:
      return new vscode.ThemeIcon(
        "circle-outline",
        new vscode.ThemeColor("descriptionForeground"),
      );
  }
}

function sshTooltipFor(d: DatasetDescriptor): string | undefined {
  if (d.source !== "ssh" || !d.ssh) return undefined;
  const state = getSshConnectionState(d.ssh);
  const host = d.ssh.alias ?? `${d.ssh.user ? `${d.ssh.user}@` : ""}${d.ssh.host}`;
  const label =
    state === "connected"
      ? "● Connected"
      : state === "connecting"
        ? "◐ Connecting…"
        : "○ Disconnected";
  return `${label}\n${host}:${d.ssh.remotePath}`;
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon("list-ordered");
  item.contextValue = `lerobotGroup-${node.groupId}`;
  return item;
}

function metadataLeafItem(node: MetadataLeafNode): vscode.TreeItem {
  const item = new vscode.TreeItem("Metadata", vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon("info");
  item.contextValue = "lerobotMetadata";
  item.tooltip = "Open dataset metadata viewer";
  item.command = {
    command: "lerobotViewer.openMetadata",
    title: "Open Metadata",
    arguments: [{ datasetId: node.datasetId }],
  };
  return item;
}

function episodeItem(node: EpisodeNode): vscode.TreeItem {
  const ep = node.episode;
  const seconds = ep.length && node.fps ? (ep.length / node.fps).toFixed(1) : "?";
  const item = new vscode.TreeItem(
    `Episode ${ep.episodeIndex.toString().padStart(4, "0")}`,
    vscode.TreeItemCollapsibleState.None,
  );
  const taskLabels = ep.tasks.map((t) => {
    const idx = node.taskMap?.[t];
    return idx !== undefined ? `[${idx}] ${t}` : t;
  });
  item.description = `${ep.length || "?"} frames · ${seconds}s${taskLabels.length ? ` · ${taskLabels.join(", ")}` : ""}`;
  item.tooltip = ep.tasks.length ? ep.tasks.join("\n") : undefined;
  item.iconPath = new vscode.ThemeIcon("play-circle");
  item.contextValue = "lerobotEpisode";
  item.command = {
    command: "lerobotViewer.previewEpisode",
    title: "Preview Episode",
    arguments: [{ datasetId: node.datasetId, episodeIndex: ep.episodeIndex }],
  };
  return item;
}

function iconForSource(source: DatasetDescriptor["source"]): string {
  switch (source) {
    case "huggingface":
      return "cloud";
    case "ssh":
      return "remote";
    case "manual":
      return "folder-library";
    case "workspace":
    default:
      return "folder";
  }
}

function sourceDescription(d: DatasetDescriptor): string {
  switch (d.source) {
    case "huggingface":
      return d.repoId ?? "huggingface";
    case "ssh":
      if (d.ssh) {
        const host = d.ssh.alias ?? `${d.ssh.user ? `${d.ssh.user}@` : ""}${d.ssh.host}`;
        return `${host}:${d.ssh.remotePath}`;
      }
      return "ssh";
    case "manual":
      return "manual";
    case "workspace":
    default:
      return "workspace";
  }
}
