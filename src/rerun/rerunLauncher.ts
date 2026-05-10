// Rerun viewer integration.
//
// We do not embed Rerun (it ships as a desktop binary). Instead we shell out
// to `rerun` and pass enough information for the user's local Rerun viewer
// to open the dataset/episode. This keeps the extension lightweight while
// letting power users wire in their own custom rerun bridges (the bridge
// resolver below is intentionally extensible).

import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { log, logError } from "../log";
import type { DatasetSnapshot, LeRobotEpisode } from "../types";

export interface RerunBridge {
  /** Stable id, e.g. "default", "lerobot-cli". */
  id: string;
  /** Human label shown in pickers. */
  label: string;
  /**
   * Build the argv passed to the rerun executable. The first element of the
   * returned array MUST NOT be the executable itself.
   */
  argv(input: { snapshot: DatasetSnapshot; episode?: LeRobotEpisode }): string[];
}

const defaultBridge: RerunBridge = {
  id: "default",
  label: "Default (rrd / video files in dataset)",
  argv({ snapshot, episode }) {
    // Heuristic: if we can resolve a per-episode rrd file, open it; otherwise
    // open the dataset root and let the user pick.
    if (snapshot.descriptor.root && episode) {
      const candidate = path.join(
        snapshot.descriptor.root,
        "rerun",
        `episode_${String(episode.episodeIndex).padStart(6, "0")}.rrd`,
      );
      return [candidate];
    }
    return [snapshot.descriptor.root ?? ""];
  },
};

const registeredBridges = new Map<string, RerunBridge>([[defaultBridge.id, defaultBridge]]);

/** Public hook for future packages (e.g. a `lerobot rerun` integration). */
export function registerRerunBridge(bridge: RerunBridge): vscode.Disposable {
  registeredBridges.set(bridge.id, bridge);
  return { dispose: () => registeredBridges.delete(bridge.id) };
}

export async function launchRerun(
  snapshot: DatasetSnapshot,
  episode?: LeRobotEpisode,
): Promise<void> {
  const bridges = Array.from(registeredBridges.values());
  const bridge =
    bridges.length === 1
      ? bridges[0]
      : await pickBridge(bridges);
  if (!bridge) return;

  const config = vscode.workspace.getConfiguration("lerobotViewer");
  const exe = config.get<string>("rerunExecutable") || "rerun";
  const args = bridge.argv({ snapshot, episode }).filter((a) => a && a.length > 0);
  log(`Launching rerun: ${exe} ${args.join(" ")}`);

  try {
    const child = cp.spawn(exe, args, {
      stdio: "ignore",
      detached: true,
      cwd: snapshot.descriptor.root,
    });
    child.on("error", (err) => {
      vscode.window.showErrorMessage(
        `Could not launch Rerun (${exe}). Install it from https://rerun.io and ensure it's on your PATH, ` +
          `or set "lerobotViewer.rerunExecutable". Underlying error: ${(err as Error).message}`,
      );
    });
    child.unref();
  } catch (err) {
    logError("rerun spawn", err);
    vscode.window.showErrorMessage(`Failed to launch Rerun: ${(err as Error).message}`);
  }
}

async function pickBridge(bridges: RerunBridge[]): Promise<RerunBridge | undefined> {
  const picked = await vscode.window.showQuickPick(
    bridges.map((b) => ({ label: b.label, description: b.id, bridge: b })),
    { placeHolder: "Select Rerun integration" },
  );
  return picked?.bridge;
}
