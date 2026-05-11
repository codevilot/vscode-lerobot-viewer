// Tiny typed wrapper over the webview's `vscode.setState/getState`.
//
// VS Code persists the bag across webview reloads (panel close + reopen
// within the same window). Anything that should NOT survive a full
// extension reload (camera visibility per dataset, panel sizes, …) belongs
// here.

import { getBridge } from "./vscode";

export interface PreviewUiState {
  /** Width in px of the right SignalGrid sidebar. */
  asideWidth?: number;
  /** Hidden camera keys keyed by dataset id. */
  hiddenCameras?: Record<string, string[]>;
}

export function readUiState(): PreviewUiState {
  return getBridge().getState<PreviewUiState>() ?? {};
}

export function patchUiState(patch: Partial<PreviewUiState>): void {
  getBridge().setState({ ...readUiState(), ...patch });
}
