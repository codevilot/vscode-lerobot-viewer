import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DatasetMetadataView, EpisodePreviewData } from "../src/types";
import { App } from "./App";
import { MetadataView } from "./MetadataView";
import { getBridge } from "./lib/vscode";

type ViewState =
  | { kind: "episode"; data: EpisodePreviewData }
  | { kind: "metadata"; data: DatasetMetadataView };

function showFatal(message: string): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-errorForeground);">
      <div style="font-weight:600;margin-bottom:8px;">LeRobot Viewer failed to start</div>
      <pre style="white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:12px;">${escape(message)}</pre>
    </div>`;
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

window.addEventListener("error", (e) => showFatal(`${e.message}\n${e.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", (e) => showFatal(String(e.reason)));

function Skeleton() {
  return (
    <div className="flex h-full flex-col gap-5 p-6">
      <div className="space-y-3">
        <div className="h-4 w-20 animate-pulse rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_8%,transparent)]" />
        <div className="h-6 w-2/3 animate-pulse rounded-md bg-[color-mix(in_srgb,var(--vscode-foreground)_8%,transparent)]" />
        <div className="h-3 w-1/3 animate-pulse rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_6%,transparent)]" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="lr-card-pad space-y-2">
            <div className="h-3 w-16 animate-pulse rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_8%,transparent)]" />
            <div className="h-6 w-20 animate-pulse rounded-md bg-[color-mix(in_srgb,var(--vscode-foreground)_8%,transparent)]" />
          </div>
        ))}
      </div>
      <div className="lr-card flex-1 animate-pulse" />
    </div>
  );
}

function Root() {
  const bridge = useMemo(() => getBridge(), []);
  const [view, setView] = useState<ViewState | undefined>();

  useEffect(() => {
    const off = bridge.onMessage((msg) => {
      if (msg.type === "init") {
        setView({ kind: "episode", data: msg.data });
      } else if (msg.type === "init-meta") {
        // Stage 1 of two-stage init: paint the page with everything we
        // know so far. Signal series are filled in by init-signals.
        setView((prev) => {
          const merged: EpisodePreviewData = {
            ...(prev?.kind === "episode" ? prev.data : EMPTY_PREVIEW),
            ...msg.data,
          };
          return { kind: "episode", data: merged };
        });
      } else if (msg.type === "init-signals") {
        setView((prev) =>
          prev?.kind === "episode"
            ? { kind: "episode", data: { ...prev.data, ...msg.data } }
            : prev,
        );
      } else if (msg.type === "init-metadata") {
        setView({ kind: "metadata", data: msg.data });
      }
    });
    bridge.postMessage({ type: "ready" });
    return () => off();
  }, [bridge]);

  if (!view) return <Skeleton />;
  if (view.kind === "metadata") return <MetadataView initial={view.data} />;
  return <App initial={view.data} />;
}

// Placeholder used when init-meta arrives before any other state. All
// fields are filled in by the message itself; we only need the
// signal-series fields to start as undefined so the SignalGrid shows
// its loading state until init-signals arrives.
const EMPTY_PREVIEW: EpisodePreviewData = {
  dataset: { id: "", name: "", source: "manual" },
  version: "unknown",
  info: { fps: 30, totalEpisodes: 0, totalFrames: 0, features: {}, raw: {} },
  episode: { episodeIndex: 0, tasks: [], length: 0 },
  cameras: [],
  rerunEnabled: false,
  tasks: [],
  episodeLengths: [],
  totalEpisodes: 0,
  stats: {},
  splits: {},
};

try {
  const container = document.getElementById("root");
  if (!container) throw new Error("#root not found");
  createRoot(container).render(<Root />);
  setTimeout(() => {
    if (container.childElementCount === 0) {
      showFatal("Webview mounted but produced no output. Open Webview Developer Tools for details.");
    }
  }, 4000);
} catch (err) {
  showFatal((err as Error).stack ?? String(err));
}
