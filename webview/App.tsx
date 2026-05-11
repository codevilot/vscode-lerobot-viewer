import { useEffect, useMemo, useRef, useState } from "react";
import type { EpisodePreviewData } from "../src/types";
import { getBridge } from "./lib/vscode";
import { patchUiState, readUiState } from "./lib/webviewState";
import { usePlayback } from "./hooks/usePlayback";
import { usePlaybackShortcuts } from "./hooks/usePlaybackShortcuts";
import { Header } from "./components/Header";
import { VideoPreview } from "./components/VideoPreview";
import { Timeline } from "./components/Timeline";
import { TransportBar } from "./components/TransportBar";
import { MetadataPanel } from "./components/MetadataPanel";
import { SignalGraph } from "./components/SignalGraph";
import { TrajectoryPlot } from "./components/TrajectoryPlot";
import { EventMarkers } from "./components/EventMarkers";
import { TaskBand } from "./components/TaskBand";

const ASIDE_MIN = 240;
const ASIDE_MAX = 720;
const ASIDE_DEFAULT = 320;

export function App({ initial }: { initial: EpisodePreviewData }) {
  const bridge = useMemo(() => getBridge(), []);
  const [data, setData] = useState<EpisodePreviewData>(initial);
  const [focusedCamera, setFocusedCamera] = useState<string | undefined>();
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [asideWidth, setAsideWidth] = useState<number>(() => {
    const w = readUiState().asideWidth;
    return typeof w === "number" && w >= ASIDE_MIN && w <= ASIDE_MAX ? w : ASIDE_DEFAULT;
  });

  // Camera visibility — persisted per dataset id. Same robot setup
  // usually reuses cameras across episodes, so hiding "cam_left" once
  // hides it for every episode of that dataset.
  const datasetCameraKey = data.dataset.id;
  const [hiddenCameras, setHiddenCameras] = useState<Set<string>>(() => {
    const stored = readUiState().hiddenCameras?.[datasetCameraKey] ?? [];
    return new Set(stored);
  });
  // Reset when navigating between different datasets within one panel.
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
      if (msg.type === "init") setData(msg.data);
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
    <div className="flex h-full min-h-0 flex-col">
      <Header data={data} />
      <div className="lr-divider mx-6" />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto scrollbar-thin">
          {hiddenCameraKeys.length > 0 && (
            <HiddenCameraBar
              hiddenKeys={hiddenCameraKeys}
              onRestore={showCamera}
              onRestoreAll={showAllCameras}
            />
          )}
          <section className={`grid gap-3 px-6 pt-4 ${gridCols}`}>
            {cameras.length === 0 && <EmptyVideoState message="No camera streams in this dataset." />}
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

          {/* Transport/Timeline/TaskBand stay visible while the viewer scrolls
              (e.g. terminal opens, viewport shrinks) so playback controls are
              always reachable. */}
          <div
            className="sticky top-0 z-10"
            style={{ background: "var(--vscode-editor-background)" }}
          >
            <FrameReadout
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

          <SignalsPanel data={data} totalFrames={totalFrames} cursorFrame={playback.frame} />
        </main>

        <AsideResizer width={asideWidth} setWidth={setAsideWidth} />
        <aside
          className="shrink-0 overflow-y-auto scrollbar-thin"
          style={{
            width: `${asideWidth}px`,
            background: "color-mix(in srgb, var(--vscode-foreground) 2%, transparent)",
          }}
        >
          <MetadataPanel data={data} />
        </aside>
      </div>
    </div>
  );
}

function SignalsPanel({
  data,
  totalFrames,
  cursorFrame,
}: {
  data: EpisodePreviewData;
  totalFrames: number;
  cursorFrame: number;
}) {
  return (
    <section className="space-y-3 px-6 py-4">
      {data.signalsWarning && (
        <div
          className="rounded-xl px-3 py-2 text-[11px]"
          style={{
            background: "color-mix(in srgb, #f5a85a 14%, transparent)",
            color: "#f5a85a",
          }}
        >
          {data.signalsWarning}
        </div>
      )}
      <SignalGraph
        title="State"
        series={data.state}
        names={data.stateNames}
        keys={featureKeys(data, "observation.state")}
        totalFrames={totalFrames}
        cursorFrame={cursorFrame}
        datasetMin={data.stats["observation.state"]?.min}
        datasetMax={data.stats["observation.state"]?.max}
        datasetMean={data.stats["observation.state"]?.mean}
      />
      <SignalGraph
        title="Action"
        series={data.action}
        names={data.actionNames}
        keys={featureKeys(data, "action")}
        totalFrames={totalFrames}
        cursorFrame={cursorFrame}
        datasetMin={data.stats["action"]?.min}
        datasetMax={data.stats["action"]?.max}
        datasetMean={data.stats["action"]?.mean}
      />
      {data.velocity && (
        <SignalGraph
          title="Velocity"
          series={data.velocity}
          names={data.velocityNames}
          keys={featureKeys(data, "observation.velocity")}
          totalFrames={totalFrames}
          cursorFrame={cursorFrame}
          datasetMin={data.stats["observation.velocity"]?.min}
          datasetMax={data.stats["observation.velocity"]?.max}
          datasetMean={data.stats["observation.velocity"]?.mean}
        />
      )}
      {data.effort && (
        <SignalGraph
          title="Effort"
          series={data.effort}
          names={data.effortNames}
          keys={featureKeys(data, "observation.effort")}
          totalFrames={totalFrames}
          cursorFrame={cursorFrame}
          datasetMin={data.stats["observation.effort"]?.min}
          datasetMax={data.stats["observation.effort"]?.max}
          datasetMean={data.stats["observation.effort"]?.mean}
        />
      )}
      {data.environmentState && (
        <SignalGraph
          title="Environment state"
          series={data.environmentState}
          names={data.environmentStateNames}
          keys={featureKeys(data, "observation.environment_state")}
          totalFrames={totalFrames}
          cursorFrame={cursorFrame}
          datasetMin={data.stats["observation.environment_state"]?.min}
          datasetMax={data.stats["observation.environment_state"]?.max}
          datasetMean={data.stats["observation.environment_state"]?.mean}
        />
      )}
      {data.reward && (
        <SignalGraph
          title="Reward"
          series={data.reward.map((v) => [v])}
          names={["reward"]}
          keys={["next.reward"]}
          totalFrames={totalFrames}
          cursorFrame={cursorFrame}
          datasetMin={data.stats["next.reward"]?.min}
          datasetMax={data.stats["next.reward"]?.max}
          datasetMean={data.stats["next.reward"]?.mean}
        />
      )}
      <EventMarkers
        series={[
          data.done && { label: "done", values: data.done, color: "#f56b8c" },
          data.success && { label: "success", values: data.success, color: "#79e08c" },
          data.truncated && { label: "truncated", values: data.truncated, color: "#f5a85a" },
        ].filter(Boolean) as { label: string; values: number[]; color: string }[]}
        totalFrames={totalFrames}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TrajectoryPlot
          title="State"
          series={data.state}
          names={data.stateNames}
          totalFrames={totalFrames}
          cursorFrame={cursorFrame}
        />
        <TrajectoryPlot
          title="Action"
          series={data.action}
          names={data.actionNames}
          totalFrames={totalFrames}
          cursorFrame={cursorFrame}
        />
      </div>
    </section>
  );
}

function featureKeys(
  data: EpisodePreviewData,
  prefix:
    | "observation.state"
    | "observation.velocity"
    | "observation.effort"
    | "observation.environment_state"
    | "action",
): string[] {
  if (!data.info.features) return [];
  return Object.keys(data.info.features).filter((k) =>
    prefix === "action" ? k === "action" || k.startsWith("action.") : k.startsWith(prefix),
  );
}

function EmptyVideoState({ message }: { message: string }) {
  return (
    <div className="col-span-full flex h-40 items-center justify-center rounded border border-dashed border-vscode-border text-vscode-muted">
      {message}
    </div>
  );
}

function FrameReadout({
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
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-6 pt-3 pb-1 lr-num">
      <Stat label="Frame">
        <span className="text-[22px] font-semibold tabular-nums">{f}</span>
        <span className="ml-1 text-[12px] text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
          / {max}
        </span>
      </Stat>
      <Stat label="Time">
        <span className="text-[22px] font-semibold tabular-nums">{formatTime(seconds)}</span>
        <span className="ml-1 text-[12px] text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
          / {formatTime(total)}
        </span>
      </Stat>
      {taskLabel && (
        <Stat label="Task">
          <span
            className="max-w-[40ch] truncate text-[15px] font-medium"
            title={taskLabel}
          >
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
    <div className="flex flex-wrap items-center gap-1.5 px-6 pt-3 text-[11px]">
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
      // Drag leftwards (smaller clientX) makes the right aside wider.
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
      aria-label="Resize metadata panel"
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
        const step = e.shiftKey ? 32 : 8;
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
      {/* Wider invisible hit area for easier grabbing. */}
      <span
        aria-hidden
        className="absolute inset-y-0 -left-1.5 -right-1.5 group-hover:bg-[color-mix(in_srgb,var(--lr-accent)_18%,transparent)]"
      />
    </div>
  );
}
