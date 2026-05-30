// Extension entry point. Wires the dataset service, tree provider, webview
// host, and command surface together. Activation is `onStartupFinished` so
// the activity bar icon shows up immediately for new users.

import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { DatasetService } from "./dataset/datasetService";
import { disposeSshPool } from "./dataset/ssh/pool";
import { DatasetTreeProvider } from "./providers/datasetTreeProvider";
import { EpisodePreviewPanelManager } from "./webview/episodePreviewPanel";
import { MetadataViewerPanelManager } from "./webview/metadataViewerPanel";
import { getLogger, log } from "./log";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(getLogger());
  log("LeRobot Viewer activating");

  const service = new DatasetService(context);
  context.subscriptions.push(service);

  const tree = new DatasetTreeProvider(service);
  context.subscriptions.push(tree);

  const treeView = vscode.window.createTreeView("lerobotViewer.datasets", {
    treeDataProvider: tree,
    // Collapse-all is removed so the navigation toolbar can host the SSH
    // button; users can still collapse a node by clicking its chevron.
    showCollapseAll: false,
    // Allow multi-select so users can batch-assign tasks to episodes.
    canSelectMany: true,
  });
  context.subscriptions.push(treeView);

  const previews = new EpisodePreviewPanelManager(context, service);
  context.subscriptions.push(previews);

  const metadataViewer = new MetadataViewerPanelManager(context, service);
  context.subscriptions.push(metadataViewer);

  registerCommands(context, service, previews, metadataViewer, tree, treeView);

  // Refresh the tree whenever workspace folders change so freshly-opened
  // folders get scanned.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void service.scanWorkspace();
    }),
  );

  if (vscode.workspace.getConfiguration("lerobotViewer").get<boolean>("autoScanWorkspace") ?? true) {
    void service.scanWorkspace();
  }
}

export async function deactivate(): Promise<void> {
  log("LeRobot Viewer deactivating");
  await disposeSshPool();
}
