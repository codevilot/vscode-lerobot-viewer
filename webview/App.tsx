import { useEffect, useMemo, useRef, useState } from "react";
import type { EpisodePreviewData } from "../src/types";
import { getBridge } from "./lib/vscode";
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

export function App({ initial }: { initial: EpisodePreviewData }) {
  const bridge = useMemo(() => getBridge(), []);
  const [data, setData] = useState<EpisodePreviewData>(initial);
  const [focusedCamera, setFocusedCamera] = useState<string | undefined>();
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

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
  const visibleCameras = focusedCamera ? cameras.filter((c) => c.key === focusedCamera) : cameras;
  const gridCols = focusedCamera
    ? "grid-cols-1"
    : cameras.length === 1
      ? "grid-cols-1"
      : cameras.length === 2
        ? "grid-cols-1 md:grid-cols-2"
        : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header data={data} />
      <div className="lr-divider mx-6" />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <section className={`grid gap-3 px-6 pt-4 ${gridCols}`}>
            {cameras.length === 0 && <EmptyVideoState message="No camera streams in this dataset." />}
            {visibleCameras.map((cam) => (
              <VideoPreview
                key={cam.key}
                camera={cam}
                isPlaying={playback.isPlaying}
                isFocused={!!focusedCamera}
                onToggleFocus={() =>
                  setFocusedCamera(focusedCamera === cam.key ? undefined : cam.key)
                }
                registerVideo={(el) => {
                  if (el) videoRefs.current.set(cam.key, el);
                  else videoRefs.current.delete(cam.key);
                }}
              />
            ))}
          </section>

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

          <SignalsPanel data={data} totalFrames={totalFrames} cursorFrame={playback.frame} />
        </main>

        <aside
          className="w-80 shrink-0 overflow-y-auto scrollbar-thin"
          style={{
            borderLeft: "1px solid var(--lr-divider)",
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
    <section className="flex-1 space-y-3 overflow-y-auto px-6 py-4 scrollbar-thin">
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
