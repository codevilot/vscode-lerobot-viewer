// DatasetService
//
// Single source of truth for the set of datasets currently visible in the
// extension. Owns:
//   - Workspace scanning (depth-limited, skips heavy folders)
//   - Manually-added folders (persisted in globalState)
//   - Hugging Face descriptors (metadata cached on disk)
//   - On-demand DatasetSnapshot loading with a tiny LRU
//
// Emits onDidChange whenever the descriptor list mutates so the
// TreeDataProvider can refresh.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { log, logError } from "../log";
import type { DatasetDescriptor, DatasetSnapshot, SshTarget } from "../types";
import { ensureHuggingFaceDataset } from "./huggingface";
import { isLeRobotDataset, loadDataset } from "./datasetLoader";
import { fetchSshDataset, sshCacheRoot } from "./ssh";

const STATE_KEY = "lerobotViewer.descriptors";
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "dist",
  "build",
  "out",
]);

export class DatasetService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private descriptors: DatasetDescriptor[] = [];
  private readonly snapshotCache = new Map<string, DatasetSnapshot>();
  private readonly loadingPromises = new Map<string, Promise<DatasetSnapshot>>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.descriptors = this.readPersisted();
  }

  list(): DatasetDescriptor[] {
    return this.descriptors.slice();
  }

  get(id: string): DatasetDescriptor | undefined {
    return this.descriptors.find((d) => d.id === id);
  }

  /**
   * Ensure a snapshot is loaded for the given descriptor. Concurrent calls
   * for the same id share a single in-flight promise.
   */
  async getSnapshot(id: string): Promise<DatasetSnapshot> {
    const cached = this.snapshotCache.get(id);
    if (cached) return cached;
    const inflight = this.loadingPromises.get(id);
    if (inflight) return inflight;

    const descriptor = this.get(id);
    if (!descriptor) throw new Error(`Unknown dataset id: ${id}`);

    const promise = (async () => {
      const snap = await loadDataset(descriptor);
      this.snapshotCache.set(id, snap);
      this.loadingPromises.delete(id);
      return snap;
    })();
    this.loadingPromises.set(id, promise);
    return promise;
  }

  invalidate(id?: string): void {
    if (id) {
      this.snapshotCache.delete(id);
    } else {
      this.snapshotCache.clear();
    }
  }

  async addLocalFolder(uri: vscode.Uri): Promise<DatasetDescriptor | undefined> {
    if (!(await isLeRobotDataset(uri.fsPath))) {
      vscode.window.showErrorMessage(
        `Folder is not a LeRobot dataset (missing meta/info.json): ${uri.fsPath}`,
      );
      return undefined;
    }
    const descriptor: DatasetDescriptor = {
      id: `local:${uri.fsPath}`,
      name: path.basename(uri.fsPath),
      root: uri.fsPath,
      source: "manual",
    };
    return this.upsert(descriptor);
  }

  async addSshDataset(target: SshTarget): Promise<DatasetDescriptor | undefined> {
    try {
      const descriptor = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Fetching ${target.user ?? ""}@${target.host}:${target.remotePath}`,
        },
        async (progress) => {
          return fetchSshDataset(target, sshCacheRoot(this.context), (msg) =>
            progress.report({ message: msg }),
          );
        },
      );
      return this.upsert(descriptor);
    } catch (err) {
      logError(`adding SSH dataset ${target.host}:${target.remotePath}`, err);
      vscode.window.showErrorMessage(
        `Could not add SSH dataset: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  async addHuggingFaceRepo(repoId: string): Promise<DatasetDescriptor | undefined> {
    try {
      const descriptor = await ensureHuggingFaceDataset(repoId);
      return this.upsert(descriptor);
    } catch (err) {
      logError(`adding HF dataset ${repoId}`, err);
      vscode.window.showErrorMessage(
        `Could not add Hugging Face dataset ${repoId}: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  remove(id: string): void {
    const before = this.descriptors.length;
    this.descriptors = this.descriptors.filter((d) => d.id !== id);
    this.snapshotCache.delete(id);
    if (this.descriptors.length !== before) {
      this.persist();
      this._onDidChange.fire();
    }
  }

  /** Scan workspace folders for datasets up to a configurable depth. */
  async scanWorkspace(): Promise<void> {
    const config = vscode.workspace.getConfiguration("lerobotViewer");
    const maxDepth = config.get<number>("workspaceScanDepth") ?? 3;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found: DatasetDescriptor[] = [];
    for (const folder of folders) {
      await walk(folder.uri.fsPath, maxDepth, async (dir) => {
        if (await isLeRobotDataset(dir)) {
          found.push({
            id: `workspace:${dir}`,
            name: path.basename(dir),
            root: dir,
            source: "workspace",
          });
          return "skip-children";
        }
        return "continue";
      });
    }

    // Reconcile: keep manual + HF entries; replace workspace entries with the
    // freshly-discovered set so removed folders disappear.
    const nonWorkspace = this.descriptors.filter((d) => d.source !== "workspace");
    this.descriptors = dedupeById([...nonWorkspace, ...found]);
    this.persist();
    this._onDidChange.fire();
    log(`Workspace scan complete: ${found.length} dataset(s) found`);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  // ---------------- internal ----------------

  private upsert(descriptor: DatasetDescriptor): DatasetDescriptor {
    const idx = this.descriptors.findIndex((d) => d.id === descriptor.id);
    if (idx >= 0) {
      this.descriptors[idx] = descriptor;
    } else {
      this.descriptors = [...this.descriptors, descriptor];
    }
    this.snapshotCache.delete(descriptor.id);
    this.persist();
    this._onDidChange.fire();
    return descriptor;
  }

  private readPersisted(): DatasetDescriptor[] {
    const raw = this.context.globalState.get<DatasetDescriptor[]>(STATE_KEY) ?? [];
    return raw.filter(isPlainDescriptor);
  }

  private persist(): void {
    // Only persist manual + huggingface entries; workspace ones are
    // recomputed on each session.
    const persistable = this.descriptors.filter((d) => d.source !== "workspace");
    void this.context.globalState.update(STATE_KEY, persistable);
  }
}

function isPlainDescriptor(value: unknown): value is DatasetDescriptor {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.source === "string";
}

function dedupeById(items: DatasetDescriptor[]): DatasetDescriptor[] {
  const seen = new Set<string>();
  return items.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

type WalkDecision = "continue" | "skip-children";

async function walk(
  root: string,
  maxDepth: number,
  visit: (dir: string, depth: number) => Promise<WalkDecision>,
): Promise<void> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let decision: WalkDecision;
    try {
      decision = await visit(dir, depth);
    } catch (err) {
      logError(`walk visit ${dir}`, err);
      continue;
    }
    if (decision === "skip-children") continue;
    if (depth >= maxDepth) continue;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
}
