// Typed messages exchanged between the extension host and the webview.
//
// IMPORTANT: this module is shared between the extension and the webview
// bundle (it is referenced from tsconfig.webview.json). Keep it free of
// any vscode/Node imports.

import type { DatasetMetadataView, EpisodePreviewData } from "../types";

export type FromExtensionMessage =
  | { type: "init"; data: EpisodePreviewData }
  | { type: "init-metadata"; data: DatasetMetadataView }
  | { type: "telemetry/log"; level: "info" | "warn" | "error"; message: string };

export type FromWebviewMessage =
  | { type: "ready" }
  | { type: "open-in-rerun" }
  | { type: "open-source-file"; path: string }
  | { type: "frame-changed"; frame: number };

export interface WebviewBridge {
  postMessage(message: FromWebviewMessage): void;
  onMessage(handler: (msg: FromExtensionMessage) => void): () => void;
  /** State checkpoint persisted by VS Code across reloads. */
  setState<T>(state: T): void;
  getState<T>(): T | undefined;
}
