// Webview host for the standalone "Dataset metadata" view. Reuses the
// shared bundle but sends an `init-metadata` payload so the React entry
// point dispatches to MetadataView.

import * as vscode from "vscode";
import type { DatasetService } from "../dataset/datasetService";
import { logError } from "../log";
import type { DatasetMetadataView } from "../types";
import { BaseWebviewPanel } from "./baseWebviewPanel";
import type { FromWebviewMessage } from "./protocol";

export class MetadataViewerPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, MetadataViewerPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: DatasetService,
  ) {}

  async show(datasetId: string): Promise<void> {
    const existing = this.panels.get(datasetId);
    if (existing) {
      existing.reveal();
      return;
    }
    let snapshot;
    try {
      snapshot = await this.service.getSnapshot(datasetId);
    } catch (err) {
      logError(`opening metadata for ${datasetId}`, err);
      vscode.window.showErrorMessage(`Could not load dataset: ${(err as Error).message}`);
      return;
    }
    const panel = new MetadataViewerPanel(this.context, snapshot.descriptor.name, () =>
      this.buildView(datasetId),
    );
    this.panels.set(datasetId, panel);
    panel.onDidDispose(() => this.panels.delete(datasetId));
  }

  private async buildView(datasetId: string): Promise<DatasetMetadataView> {
    const snapshot = await this.service.getSnapshot(datasetId);
    return {
      descriptor: snapshot.descriptor,
      version: snapshot.version,
      info: snapshot.info,
      cameraKeys: snapshot.cameraKeys,
      stateKeys: snapshot.stateKeys,
      actionKeys: snapshot.actionKeys,
      velocityKeys: snapshot.velocityKeys,
      effortKeys: snapshot.effortKeys,
      environmentStateKeys: snapshot.environmentStateKeys,
      rewardKey: snapshot.rewardKey,
      doneKey: snapshot.doneKey,
      successKey: snapshot.successKey,
      truncatedKey: snapshot.truncatedKey,
      taskIndexKey: snapshot.taskIndexKey,
      tasks: snapshot.tasks,
      stats: snapshot.stats,
      splits: snapshot.splits,
      episodeLengths: snapshot.episodes.map((e) => e.length || 0),
      warnings: snapshot.warnings,
    };
  }

  dispose(): void {
    for (const p of this.panels.values()) p.dispose();
    this.panels.clear();
  }
}

class MetadataViewerPanel extends BaseWebviewPanel {
  constructor(
    context: vscode.ExtensionContext,
    title: string,
    private readonly fetchView: () => Promise<DatasetMetadataView>,
  ) {
    super({
      context,
      viewType: "lerobotMetadataViewer",
      title: `${title} · metadata`,
    });
  }

  protected async onMessage(message: FromWebviewMessage): Promise<void> {
    if (message.type === "ready") {
      this.post({ type: "init-metadata", data: await this.fetchView() });
    }
  }
}
