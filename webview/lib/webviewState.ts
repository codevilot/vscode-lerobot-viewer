// Tiny typed wrapper over the webview's `vscode.setState/getState`.
//
// VS Code persists the bag across webview reloads (panel close + reopen
// within the same window). Anything that should NOT survive a full
// extension reload (camera visibility per dataset, panel sizes, …) belongs
// here.

import { getBridge } from "./vscode";

export interface PreviewUiState {
  /** Width in px of the right MetadataPanel sidebar. */
  asideWidth?: number;
  /** Height in px applied to every SignalGraph chart area. */
  signalHeight?: number;
  /** Hidden camera keys keyed by `${datasetId}:${episodeIndex}`. */
  hiddenCameras?: Record<string, string[]>;
  /** Compare state vs action (per-dim split) toggle. */
  compareStateAction?: boolean;
}

export function readUiState(): PreviewUiState {
  return getBridge().getState<PreviewUiState>() ?? {};
}

export function patchUiState(patch: Partial<PreviewUiState>): void {
  getBridge().setState({ ...readUiState(), ...patch });
}
