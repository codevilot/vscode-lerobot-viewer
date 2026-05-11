import { useEffect, useMemo, useRef, useState } from "react";
import type { EpisodePreviewData } from "../src/types";
import { getBridge } from "./lib/vscode";
import { patchUiState, readUiState } from "./lib/webviewState";
import { usePlayback } from "./hooks/usePlayback";
import { usePlaybackShortcuts } from "./hooks/usePlaybackShortcuts";
import { VideoPreview } from "./components/VideoPreview";
import { Timeline } from "./components/Timeline";
import { TransportBar } from "./components/TransportBar";
import { TaskBand } from "./components/TaskBand";
import { SignalGrid } from "./components/SignalGrid";

const ASIDE_MIN = 360;
const ASIDE_MAX = 1100;
const ASIDE_DEFAULT = 620;

// Below this preview-panel width the side-by-side layout gets cramped
// (cameras squished, only a couple state/action rows visible), so we
// fall back to a top/bottom 50/50 stack: videos up top, signals below.
const STACK_THRESHOLD_PX = 720;

export function App({ initial }: { initial: EpisodePreviewData }) {
  const bridge = useMemo(() => getBridge(), []);
  const [data, setData] = useState<EpisodePreviewData>(initial);
  const [focusedCamera, setFocusedCamera] = useState<string | undefined>();
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [asideWidth, setAsideWidth] = useState<number>(() => {
    const w = readUiState().asideWidth;
    return typeof w === "number" && w >= ASIDE_MIN && w <= ASIDE_MAX ? w : ASIDE_DEFAULT;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState<boolean>(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) setStacked(e.contentRect.width < STACK_THRESHOLD_PX);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Camera visibility — persisted per dataset id. Same robot setup
  // usually reuses cameras across episodes, so hiding "cam_left" once
  // hides it for every episode of that dataset.
  const datasetCameraKey = data.dataset.id;
  const [hiddenCameras, setHiddenCameras] = useState<Set<string>>(() => {
    const stored = readUiState().hiddenCameras?.[datasetCameraKey] ?? [];
    return new Set(stored);
  });
  useEffect(() => {
    const stored = readUiState().hiddenCameras?.[datasetCameraKey] ?? [];
    setHiddenCameras(new Set(stored));
  }, [datasetCameraKey]);

  const persistHidden = (next: Set<string>) => {
    const all = readUiState().hiddenCameras ?? {};
    patchUiState({
      hiddenCameras: { ...all, [datasetCameraKey]: [...next] },
    });
  };
  const hideCamera = (key: string) => {
    setHiddenCameras((prev) => {
      const next = new Set(prev);
      next.add(key);
      persistHidden(next);
      return next;
    });
    if (focusedCamera === key) setFocusedCamera(undefined);
  };
  const showCamera = (key: string) => {
    setHiddenCameras((prev) => {
      const next = new Set(prev);
      next.delete(key);
      persistHidden(next);
      return next;
    });
  };
  const showAllCameras = () => {
    setHiddenCameras(new Set());
    persistHidden(new Set());
  };

  const fps = data.info.fps || 30;
  const totalFrames = data.episode.length ?? 0;

  const playback = usePlayback(videoRefs, fps, totalFrames);
  usePlaybackShortcuts(playback, fps, totalFrames);

  useEffect(() => {
    const off = bridge.onMessage((msg) => {
      if (msg.type === "init") {
        setData(msg.data);
      } else if (msg.type === "init-meta") {
        // Stage 1 — paint videos + meta now, keep any existing
        // signals around (Root passes us a stitched merge).
        setData((prev) => ({ ...prev, ...msg.data }));
      } else if (msg.type === "init-signals") {
        setData((prev) => ({ ...prev, ...msg.data }));
      }
    });
    return () => off();
  }, [bridge]);

  useEffect(() => {
    bridge.postMessage({ type: "frame-changed", frame: playback.frame });
  }, [bridge, playback.frame]);

  const cameras = data.cameras;
  const shownCameras = cameras.filter((c) => !hiddenCameras.has(c.key));
  const visibleCameras = focusedCamera
    ? shownCameras.filter((c) => c.key === focusedCamera)
    : shownCameras;
  const hiddenCameraKeys = cameras
    .filter((c) => hiddenCameras.has(c.key))
    .map((c) => c.key);
  const gridCols = focusedCamera
    ? "grid-cols-1"
    : shownCameras.length <= 1
      ? "grid-cols-1"
      : shownCameras.length === 2
        ? "grid-cols-1 md:grid-cols-2"
        : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 ${stacked ? "flex-col" : "flex-row"}`}
    >
      {/* TOP (stacked) / LEFT (split): cameras + playback controls */}
      <main
        className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${
          stacked ? "basis-0 flex-1" : "flex-1"
        }`}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto scrollbar-thin">
          {hiddenCameraKeys.length > 0 && (
            <HiddenCameraBar
              hiddenKeys={hiddenCameraKeys}
              onRestore={showCamera}
              onRestoreAll={showAllCameras}
            />
          )}
          <section className={`grid gap-3 px-5 pt-5 ${gridCols}`}>
            {cameras.length === 0 && (
              <EmptyVideoState message={`No video streams for episode #${data.episode.episodeIndex}`} />
            )}
            {cameras.length > 0 && visibleCameras.length === 0 && (
              <EmptyVideoState message="All cameras are hidden — click a chip above to restore." />
            )}
            {visibleCameras.map((cam) => (
              <VideoPreview
                key={cam.key}
                camera={cam}
                isPlaying={playback.isPlaying}
                isFocused={!!focusedCamera}
                onToggleFocus={() =>
                  setFocusedCamera(focusedCamera === cam.key ? undefined : cam.key)
                }
                onHide={() => hideCamera(cam.key)}
                registerVideo={(el) => {
                  if (el) videoRefs.current.set(cam.key, el);
                  else videoRefs.current.delete(cam.key);
                }}
              />
            ))}
          </section>
          <div className="h-5" />
        </div>

        {/* Playback dock — fixed at the bottom of the left column so
            controls stay reachable regardless of camera grid size. */}
        <div
          className="shrink-0 border-t border-[var(--lr-divider)]"
          style={{ background: "var(--vscode-editor-background)" }}
        >
          <FrameReadoutRow
            frame={playback.frame}
            totalFrames={totalFrames}
            fps={fps}
            taskIndices={data.taskIndices}
            tasks={data.tasks}
          />
          <TransportBar
            isPlaying={playback.isPlaying}
            loop={playback.loop}
            speed={playback.speed}
            frame={playback.frame}
            totalFrames={totalFrames}
            fps={fps}
            onPlayPause={() => playback.setIsPlaying((p) => !p)}
            onSeek={playback.seek}
            onSpeed={playback.setSpeed}
            onLoopToggle={() => playback.setLoop((p) => !p)}
          />
          <Timeline
            frame={playback.frame}
            totalFrames={totalFrames}
            fps={fps}
            onChange={playback.seek}
          />
          {data.taskIndices && (
            <TaskBand
              taskIndices={data.taskIndices}
              totalFrames={totalFrames}
              taskLabels={Object.fromEntries(data.tasks.map((t) => [t.taskIndex, t.task]))}
            />
          )}
        </div>
      </main>

      {stacked ? (
        <div
          className="h-px shrink-0"
          style={{ background: "var(--lr-divider)" }}
          aria-hidden
        />
      ) : (
        <AsideResizer width={asideWidth} setWidth={setAsideWidth} />
      )}

      {/* BOTTOM (stacked) / RIGHT (split): compact episode meta + state/action grid */}
      <aside
        className={`flex min-h-0 shrink-0 flex-col ${stacked ? "basis-0 flex-1" : ""}`}
        style={
          stacked
            ? { background: "color-mix(in srgb, var(--vscode-foreground) 2%, transparent)" }
            : {
                width: `${asideWidth}px`,
                background: "color-mix(in srgb, var(--vscode-foreground) 2%, transparent)",
              }
        }
      >
        <EpisodeMetaHeader data={data} />
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 pb-6">
          <SignalGrid
            stateSeries={data.state}
            actionSeries={data.action}
            stateNames={data.stateNames}
            actionNames={data.actionNames}
            totalFrames={totalFrames}
            cursorFrame={playback.frame}
            stateStd={data.stats["observation.state"]?.std}
            actionStd={data.stats["action"]?.std}
            onSeek={playback.seek}
          />
        </div>
      </aside>
    </div>
  );
}

function EpisodeMetaHeader({ data }: { data: EpisodePreviewData }) {
  const ep = data.episode;
  const fps = data.info.fps || 30;
  const frames = ep.length ?? 0;
  const duration = frames / Math.max(1, fps);
  const task = ep.tasks[0];
  const epLabel = `ep_${ep.episodeIndex.toString().padStart(3, "0")}`;

  return (
    <header className="shrink-0 border-b border-[var(--lr-divider)] px-4 pt-4 pb-3">
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="truncate text-[13px] font-semibold text-[color-mix(in_srgb,var(--vscode-foreground)_75%,transparent)]">
          {data.dataset.name}
        </h1>
        <span className="text-[11px] tabular-nums text-[color-mix(in_srgb,var(--vscode-foreground)_45%,transparent)]">
          {data.version}
        </span>
      </div>
      <MetaRow label="episode" value={epLabel} mono accent="rust" />
      <MetaRow label="frames" value={frames.toLocaleString()} />
      <MetaRow label="duration" value={`${duration.toFixed(2)}s`} />
      <MetaRow label="fps" value={String(data.info.fps)} />
      {task && <MetaRow label="task" value={task} truncate />}
      {data.episodeSplit && <MetaRow label="split" value={data.episodeSplit} accent="green" />}
      {data.info.robotType && data.info.robotType !== "unknown" && (
        <MetaRow label="robot" value={data.info.robotType} />
      )}
    </header>
  );
}

function MetaRow({
  label,
  value,
  mono,
  accent,
  truncate,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "rust" | "green";
  truncate?: boolean;
}) {
  const color =
    accent === "rust"
      ? "#d97757"
      : accent === "green"
        ? "#79e08c"
        : "color-mix(in srgb, var(--vscode-foreground) 85%, transparent)";
  return (
    <div className="flex items-baseline justify-between py-[3px] text-[12px]">
      <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
        {label}
      </span>
      <span
        className={`tabular-nums ${mono ? "font-mono" : ""} ${truncate ? "ml-3 max-w-[60%] truncate" : ""}`}
        style={{ color }}
        title={truncate ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function FrameReadoutRow({
  frame,
  totalFrames,
  fps,
  taskIndices,
  tasks,
}: {
  frame: number;
  totalFrames: number;
  fps: number;
  taskIndices?: number[];
  tasks: EpisodePreviewData["tasks"];
}) {
  const max = Math.max(0, totalFrames - 1);
  const f = Math.round(frame);
  const seconds = f / Math.max(1, fps);
  const total = max / Math.max(1, fps);
  const taskIdx =
    taskIndices && f < taskIndices.length ? taskIndices[f] : undefined;
  const taskLabel =
    taskIdx !== undefined
      ? tasks.find((t) => t.taskIndex === taskIdx)?.task ?? `task ${taskIdx}`
      : undefined;
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 pt-3 pb-1 lr-num">
      <Stat label="Frame">
        <span className="text-[20px] font-semibold tabular-nums">{f}</span>
        <span className="ml-1 text-[12px] text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
          / {max}
        </span>
      </Stat>
      <Stat label="Time">
        <span className="text-[20px] font-semibold tabular-nums">{formatTime(seconds)}</span>
        <span className="ml-1 text-[12px] text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
          / {formatTime(total)}
        </span>
      </Stat>
      {taskLabel && (
        <Stat label="Task">
          <span className="max-w-[40ch] truncate text-[14px] font-medium" title={taskLabel}>
            {taskLabel}
          </span>
        </Stat>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wide text-[color-mix(in_srgb,var(--vscode-foreground)_45%,transparent)]">
        {label}
      </span>
      <span className="flex items-baseline">{children}</span>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function EmptyVideoState({ message }: { message: string }) {
  return (
    <div className="col-span-full flex h-40 items-center justify-center rounded border border-dashed border-vscode-border text-vscode-muted">
      {message}
    </div>
  );
}

function HiddenCameraBar({
  hiddenKeys,
  onRestore,
  onRestoreAll,
}: {
  hiddenKeys: string[];
  onRestore: (key: string) => void;
  onRestoreAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pt-3 text-[11px]">
      <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        Hidden:
      </span>
      {hiddenKeys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onRestore(k)}
          className="rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors"
          style={{
            background: "color-mix(in srgb, var(--vscode-foreground) 8%, transparent)",
            border: "1px solid var(--lr-divider)",
          }}
          title={`Show ${k}`}
        >
          {k} <span aria-hidden>+</span>
        </button>
      ))}
      {hiddenKeys.length > 1 && (
        <button
          type="button"
          onClick={onRestoreAll}
          className="rounded-full px-2 py-0.5 text-[11px]"
          style={{ color: "var(--lr-accent)" }}
        >
          Show all
        </button>
      )}
    </div>
  );
}

function AsideResizer({
  width,
  setWidth,
}: {
  width: number;
  setWidth: (next: number) => void;
}) {
  const startRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const start = startRef.current;
      if (!start) return;
      const next = Math.max(ASIDE_MIN, Math.min(ASIDE_MAX, start.w + (start.x - e.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      if (!startRef.current) return;
      startRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      patchUiState({ asideWidth: width });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setWidth, width]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize state/action panel"
      tabIndex={0}
      className="group relative w-1 shrink-0 cursor-col-resize"
      style={{ background: "var(--lr-divider)" }}
      onMouseDown={(e) => {
        startRef.current = { x: e.clientX, w: width };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        e.preventDefault();
      }}
      onDoubleClick={() => {
        setWidth(ASIDE_DEFAULT);
        patchUiState({ asideWidth: ASIDE_DEFAULT });
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") {
          const next = Math.min(ASIDE_MAX, width + step);
          setWidth(next);
          patchUiState({ asideWidth: next });
          e.preventDefault();
        } else if (e.key === "ArrowRight") {
          const next = Math.max(ASIDE_MIN, width - step);
          setWidth(next);
          patchUiState({ asideWidth: next });
          e.preventDefault();
        }
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 -left-1.5 -right-1.5 group-hover:bg-[color-mix(in_srgb,var(--lr-accent)_18%,transparent)]"
      />
    </div>
  );
}
