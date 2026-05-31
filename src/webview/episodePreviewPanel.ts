// Episode preview webview host.
// Owns one panel per (dataset, episode) pair; opening the same pair again
// just reveals the existing panel.

import * as vscode from "vscode";
import { resolveVideoUri } from "../dataset/datasetLoader";
import type { DatasetService } from "../dataset/datasetService";
import { readEpisodeSignals } from "../dataset/parquetReader";
import { log, logError } from "../log";
import { launchRerun } from "../rerun/rerunLauncher";
import { serveVideo, stopServeVideo } from "./videoServer";
import type { LeRobotEpisode } from "../types";
import { BaseWebviewPanel } from "./baseWebviewPanel";
import type { FromWebviewMessage } from "./protocol";

export class EpisodePreviewPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, EpisodePreviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: DatasetService,
  ) {}

  async show(datasetId: string, episodeIndex: number): Promise<void> {
    const key = `${datasetId}::${episodeIndex}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    let snapshot;
    try {
      snapshot = await this.service.getSnapshot(datasetId);
    } catch (err) {
      logError(`opening episode ${episodeIndex} of ${datasetId}`, err);
      vscode.window.showErrorMessage(`Could not load dataset: ${(err as Error).message}`);
      return;
    }

    const episode = snapshot.episodes.find((e) => e.episodeIndex === episodeIndex);
    if (!episode) {
      vscode.window.showErrorMessage(
        `Episode ${episodeIndex} not found in ${snapshot.descriptor.name}`,
      );
      return;
    }

    const panel = new EpisodePreviewPanel(
      this.context,
      this.service,
      snapshot.descriptor,
      episode,
    );
    this.panels.set(key, panel);
    panel.onDidDispose(() => this.panels.delete(key));
  }

  dispose(): void {
    for (const p of this.panels.values()) p.dispose();
    this.panels.clear();
  }
}

class EpisodePreviewPanel extends BaseWebviewPanel {
  constructor(
    context: vscode.ExtensionContext,
    private readonly service: DatasetService,
    descriptor: { id: string; name: string; root?: string },
    private readonly episode: LeRobotEpisode,
  ) {
    super({
      context,
      viewType: "lerobotEpisodePreview",
      title: `${descriptor.name} · Episode ${episode.episodeIndex}`,
      extraResourceRoots: descriptor.root ? [vscode.Uri.file(descriptor.root)] : [],
    });
    this.datasetId = descriptor.id;
  }

  private readonly datasetId: string;

  protected override extraCspDirectives(): Array<[string, string]> {
    return [["media-src", `${this.panel.webview.cspSource} https: blob: http://127.0.0.1:*`]];
  }

  protected async onMessage(message: FromWebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready": {
        // Two-stage init: send everything-but-signals first so the
        // webview can paint videos + meta immediately, then send
        // signals once parquet decode finishes. Especially helps SSH
        // datasets, where signal decode is gated on a multi-second
        // shard download.
        const snapshot = await this.service.getSnapshot(this.datasetId);
        const meta = await this.buildMeta(snapshot);
        this.post({ type: "init-meta", data: meta });
        const signals = await this.buildSignals(snapshot);
        this.post({ type: "init-signals", data: signals });
        return;
      }
      case "open-in-rerun": {
        const snapshot = await this.service.getSnapshot(this.datasetId);
        await launchRerun(snapshot, this.episode);
        return;
      }
      case "open-source-file": {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(message.path));
        return;
      }
      case "frame-changed":
        // Reserved for future bidirectional sync (timeline ↔ Rerun).
        return;
    }
  }

  private async buildMeta(snapshot: Awaited<ReturnType<DatasetService["getSnapshot"]>>) {
    const cameras = await Promise.all(
      snapshot.cameraKeys.map(async (key) => {
        const resolved = await resolveVideoUri(snapshot, this.episode, key);
        if (!resolved) return { key };
        // Large videos → stream via our own HTTP server (supports Range).
        // Small videos → VS Code webview local server (simpler, no Range needed).
        let sz = 0;
        try { sz = (await import("node:fs/promises").then((m) => m.stat(resolved.uri.fsPath))).size; } catch { /* ok */ }
        const useStreaming = sz > 50 * 1024 * 1024;
        const videoUri = useStreaming
          ? await serveVideo(resolved.uri.fsPath)
          : this.panel.webview.asWebviewUri(resolved.uri).toString();
        return {
          key,
          videoUri,
          shardFrameRange: resolved.location.shardFrameRange,
          note: resolved.location.note,
        };
      }),
    );
    const rerunEnabled =
      vscode.workspace.getConfiguration("lerobotViewer").get<boolean>("enableRerun") ?? false;
    const episodeSplit = pickSplitForEpisode(snapshot.splits, this.episode.episodeIndex);

    return {
      dataset: snapshot.descriptor,
      version: snapshot.version,
      info: snapshot.info,
      episode: this.episode,
      cameras,
      stateNames: collectFeatureNames(snapshot.info.features, snapshot.stateKeys),
      actionNames: collectFeatureNames(snapshot.info.features, snapshot.actionKeys),
      velocityNames: collectFeatureNames(snapshot.info.features, snapshot.velocityKeys),
      effortNames: collectFeatureNames(snapshot.info.features, snapshot.effortKeys),
      environmentStateNames: collectFeatureNames(
        snapshot.info.features,
        snapshot.environmentStateKeys,
      ),
      rerunEnabled,
      tasks: snapshot.tasks,
      episodeLengths: snapshot.episodes.map((e) => e.length || 0),
      totalEpisodes: snapshot.info.totalEpisodes,
      stats: snapshot.stats,
      splits: snapshot.splits,
      episodeSplit,
    };
  }

  private async buildSignals(snapshot: Awaited<ReturnType<DatasetService["getSnapshot"]>>) {
    const signals = await readEpisodeSignals(snapshot, this.episode);
    log(
      `Preview signals for ${snapshot.descriptor.name} ep ${this.episode.episodeIndex}: ` +
        `state=${signals.state?.length ?? 0}f, action=${signals.action?.length ?? 0}f`,
    );
    return {
      state: signals.state,
      action: signals.action,
      velocity: signals.velocity,
      effort: signals.effort,
      environmentState: signals.environmentState,
      reward: signals.reward,
      done: signals.done,
      success: signals.success,
      truncated: signals.truncated,
      taskIndices: signals.taskIndices,
      signalsWarning: signals.warning,
    };
  }
}

function collectFeatureNames(
  features: Record<string, { names?: unknown }>,
  keys: string[],
): string[] | undefined {
  const collected: string[] = [];
  for (const key of keys) {
    const f = features[key];
    if (!f) continue;
    if (Array.isArray(f.names)) {
      collected.push(...(f.names as string[]));
    } else if (f.names && typeof f.names === "object") {
      // Some datasets nest names under a sub-key like {"motors": [...]}.
      for (const v of Object.values(f.names as Record<string, unknown>)) {
        if (Array.isArray(v)) collected.push(...(v as string[]));
      }
    }
  }
  return collected.length > 0 ? collected : undefined;
}

function pickSplitForEpisode(
  splits: Record<string, [number, number]>,
  episodeIndex: number,
): string | undefined {
  for (const [name, [from, to]] of Object.entries(splits)) {
    if (episodeIndex >= from && episodeIndex < to) return name;
  }
  return undefined;
}
