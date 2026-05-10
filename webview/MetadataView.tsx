// Dedicated dataset metadata viewer.
//
// Shows the entire static metadata surface of a dataset (info.json,
// stats.json, tasks, splits, schema) in a single Toss-styled scrollable
// page. Designed to be the canonical place to answer "what does this
// dataset contain?" without ever opening an episode.

import { useMemo, useState } from "react";
import type {
  DatasetMetadataView,
  FeatureSpec,
  FeatureStats,
  TaskInfo,
} from "../src/types";

export function MetadataView({ initial }: { initial: DatasetMetadataView }) {
  const data = initial;
  const fps = data.info.fps || 1;
  const totalDurationSec = data.info.totalFrames / fps;
  const lengthStats = useMemo(() => computeLengthStats(data.episodeLengths), [data.episodeLengths]);
  const grouped = useMemo(() => groupFeatures(data.info.features), [data.info.features]);

  return (
    <div className="mx-auto h-full max-w-[960px] overflow-y-auto scrollbar-thin px-8 py-8">
      <Hero data={data} />

      <Section title="At a glance">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Episodes" value={data.info.totalEpisodes.toLocaleString()} />
          <Kpi label="Frames" value={data.info.totalFrames.toLocaleString()} />
          <Kpi label="Duration" value={formatDuration(totalDurationSec)} />
          <Kpi label="FPS" value={String(data.info.fps)} />
          {data.info.totalTasks !== undefined && <Kpi label="Tasks" value={String(data.info.totalTasks)} />}
          {data.info.totalChunks !== undefined && <Kpi label="Chunks" value={String(data.info.totalChunks)} />}
          {data.info.chunksSize !== undefined && (
            <Kpi label="Chunk size" value={data.info.chunksSize.toLocaleString()} />
          )}
          {data.info.totalVideos !== undefined && <Kpi label="Videos" value={String(data.info.totalVideos)} />}
          {lengthStats && (
            <Kpi
              label="Avg episode"
              value={`${(lengthStats.mean / fps).toFixed(1)}s`}
              hint={`${lengthStats.mean.toFixed(0)} fr`}
            />
          )}
          {data.info.codebaseVersion && <Kpi label="Codebase" value={data.info.codebaseVersion} mono />}
          {data.info.robotType && <Kpi label="Robot" value={data.info.robotType} />}
        </div>
      </Section>

      {Object.keys(data.splits).length > 0 && (
        <Section title="Splits">
          <SplitsBlock data={data} />
        </Section>
      )}

      <Section title={`Cameras · ${data.cameraKeys.length}`}>
        {data.cameraKeys.length === 0 ? (
          <Empty>No camera streams declared.</Empty>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.cameraKeys.map((key) => (
              <CameraCard key={key} cameraKey={key} feature={data.info.features[key]} />
            ))}
          </div>
        )}
      </Section>

      <Section title={`Tasks · ${data.tasks.length}`}>
        {data.tasks.length === 0 ? <Empty>No tasks declared.</Empty> : <TasksBlock tasks={data.tasks} />}
      </Section>

      {data.episodeLengths.length > 1 && lengthStats && (
        <Section title="Episode length distribution">
          <Histogram lengths={data.episodeLengths} stats={lengthStats} />
        </Section>
      )}

      <Section title={`Schema · ${Object.keys(data.info.features).length}`}>
        <div className="space-y-3">
          {grouped.map(({ title, items }) =>
            items.length === 0 ? null : (
              <SchemaGroup
                key={title}
                title={title}
                items={items}
                stats={data.stats}
                names={collectNamesForKey}
                data={data}
              />
            ),
          )}
        </div>
      </Section>

      {hasAnyStats(data.stats) && (
        <Section title="Signal ranges (dataset-wide stats)">
          <div className="space-y-3">
            {(
              [
                "observation.state",
                "action",
                "observation.velocity",
                "observation.effort",
                "observation.environment_state",
                "next.reward",
              ] as const
            ).map((key) => {
              const s = data.stats[key];
              if (!s || (!s.min && !s.max)) return null;
              return (
                <RangeCard
                  key={key}
                  title={prettyKey(key)}
                  stats={s}
                  names={collectNamesForKey(data, key)}
                />
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Storage layout">
        <div className="lr-card-pad space-y-2 text-[12px]">
          <Row label="Codebase version" value={data.info.codebaseVersion ?? "—"} mono />
          <Row label="Detected version" value={data.version} mono />
          {data.info.dataPath && <Row label="data_path" value={data.info.dataPath} mono />}
          {data.info.videoPath && <Row label="video_path" value={data.info.videoPath} mono />}
          {data.info.chunksSize !== undefined && <Row label="chunks_size" value={String(data.info.chunksSize)} mono />}
          {data.info.totalChunks !== undefined && <Row label="total_chunks" value={String(data.info.totalChunks)} mono />}
          {data.descriptor.root && <Row label="Local path" value={data.descriptor.root} mono small />}
          {data.descriptor.repoId && <Row label="HF repo" value={data.descriptor.repoId} mono />}
        </div>
      </Section>

      {data.warnings.length > 0 && (
        <Section title="Warnings">
          <ul className="space-y-2">
            {data.warnings.map((w, i) => (
              <li
                key={i}
                className="rounded-xl px-3 py-2 text-[12px]"
                style={{
                  background: "color-mix(in srgb, #f5a85a 14%, transparent)",
                  color: "#f5a85a",
                }}
              >
                {w}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Raw info.json">
        <RawJson data={data.info.raw} />
      </Section>
    </div>
  );
}

// =============================================================
// Sections
// =============================================================

function Hero({ data }: { data: DatasetMetadataView }) {
  return (
    <header className="mb-8 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <VersionBadge version={data.version} />
          {data.descriptor.repoId && <span className="lr-badge">HuggingFace</span>}
          {Object.keys(data.splits).length > 0 && <span className="lr-badge">{Object.keys(data.splits).length} splits</span>}
        </div>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight">{data.descriptor.name}</h1>
        {data.descriptor.repoId && (
          <p className="mt-1 font-mono text-[13px] text-[color-mix(in_srgb,var(--vscode-foreground)_60%,transparent)]">
            🤗 {data.descriptor.repoId}
          </p>
        )}
        {data.descriptor.root && (
          <p className="mt-1 truncate font-mono text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
            {data.descriptor.root}
          </p>
        )}
      </div>
    </header>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="lr-section-label mb-3 pb-2 lr-divider">{title}</h2>
      {children}
    </section>
  );
}

function Kpi({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="lr-card-pad">
      <div className="lr-stat-label">{label}</div>
      <div className={`lr-stat-value mt-1.5 ${mono ? "font-mono text-[14px]" : ""}`}>{value}</div>
      {hint && (
        <div className="lr-num mt-1 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_45%,transparent)]">
          {hint}
        </div>
      )}
    </div>
  );
}

function CameraCard({ cameraKey, feature }: { cameraKey: string; feature?: FeatureSpec }) {
  const shape = feature?.shape;
  const tech = feature?.info ?? {};
  const codec = pickString(tech["video.codec"]);
  const camFps = pickNumber(tech["video.fps"]);
  const pixFmt = pickString(tech["video.pix_fmt"]);
  const isDepth = tech["video.is_depth_map"] === true;
  const hasAudio = tech.has_audio === true;
  const resolution = shape && shape.length >= 2 ? `${shape[1]}×${shape[0]}` : undefined;
  return (
    <div className="lr-card-pad">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[12px]">{cameraKey}</span>
        <span className="lr-badge">{feature?.dtype ?? "video"}</span>
      </div>
      <div className="lr-num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        {resolution && <Pair k="resolution" v={resolution} />}
        {camFps !== undefined && <Pair k="fps" v={String(camFps)} />}
        {codec && <Pair k="codec" v={codec} mono />}
        {pixFmt && <Pair k="pix_fmt" v={pixFmt} mono />}
        {shape && <Pair k="shape" v={`[${shape.join(", ")}]`} mono />}
      </div>
      {(isDepth || hasAudio) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {isDepth && <span className="lr-badge">depth</span>}
          {hasAudio && <span className="lr-badge">audio</span>}
        </div>
      )}
    </div>
  );
}

function Pair({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">{k}</span>
      <span className={`text-right ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

function TasksBlock({ tasks }: { tasks: TaskInfo[] }) {
  const totalCount = tasks.reduce((acc, t) => acc + (t.episodeCount ?? 0), 0);
  return (
    <ul className="space-y-2">
      {tasks.map((t) => {
        const pct =
          t.episodeCount !== undefined && totalCount > 0
            ? Math.round((t.episodeCount / totalCount) * 100)
            : undefined;
        return (
          <li key={t.taskIndex} className="lr-card-pad relative overflow-hidden">
            {pct !== undefined && (
              <div
                aria-hidden
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${pct}%`,
                  background: "color-mix(in srgb, var(--lr-accent) 8%, transparent)",
                }}
              />
            )}
            <div className="relative flex items-baseline justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] leading-snug">{t.task}</div>
                <div className="lr-num mt-0.5 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
                  task {t.taskIndex}
                  {t.episodeCount !== undefined && (
                    <>
                      {" · "}
                      {t.episodeCount.toLocaleString()} episodes
                      {pct !== undefined && ` · ${pct}%`}
                    </>
                  )}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SplitsBlock({ data }: { data: DatasetMetadataView }) {
  const total = data.info.totalEpisodes;
  return (
    <ul className="space-y-2">
      {Object.entries(data.splits).map(([name, [from, to]]) => {
        const count = to - from;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <li key={name} className="lr-card-pad relative overflow-hidden">
            <div
              aria-hidden
              className="absolute inset-y-0 left-0"
              style={{
                width: `${pct}%`,
                background: "color-mix(in srgb, var(--lr-accent) 12%, transparent)",
              }}
            />
            <div className="relative flex items-baseline justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold">{name}</div>
                <div className="lr-num mt-0.5 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
                  {from.toLocaleString()}–{to.toLocaleString()} · {count.toLocaleString()} episodes ({pct}%)
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Histogram({
  lengths,
  stats,
}: {
  lengths: number[];
  stats: { min: number; max: number; mean: number };
}) {
  const bins = 24;
  const data = useMemo(() => buildHistogram(lengths, bins), [lengths]);
  if (!data) return null;
  const peak = Math.max(...data.counts, 1);
  const w = 600;
  const h = 80;
  return (
    <div className="lr-card-pad space-y-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="block h-20 w-full" preserveAspectRatio="none">
        {data.counts.map((c, i) => {
          const x = (i / bins) * w;
          const barH = (c / peak) * (h - 4);
          return (
            <rect
              key={i}
              x={x + 0.5}
              y={h - barH}
              width={w / bins - 1}
              height={barH}
              fill="var(--lr-accent)"
              opacity={0.7}
            />
          );
        })}
      </svg>
      <div className="lr-num flex flex-wrap gap-x-4 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        <span>min {stats.min.toLocaleString()}</span>
        <span>max {stats.max.toLocaleString()}</span>
        <span>μ {stats.mean.toFixed(1)}</span>
      </div>
    </div>
  );
}

function SchemaGroup({
  title,
  items,
  stats,
  names,
  data,
}: {
  title: string;
  items: Array<[string, FeatureSpec]>;
  stats: Record<string, FeatureStats>;
  names: typeof collectNamesForKey;
  data: DatasetMetadataView;
}) {
  return (
    <details className="lr-card group" open>
      <summary className="cursor-pointer list-none px-4 py-2.5 text-[12px] font-semibold transition-colors hover:bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)]">
        <span className="select-none">
          <span className="mr-2 inline-block w-3 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)] transition-transform group-open:rotate-90">
            ▶
          </span>
          {title}
          <span className="ml-2 text-[11px] font-normal text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
            {items.length}
          </span>
        </span>
      </summary>
      <ul className="space-y-1 px-4 pb-3">
        {items.map(([key, feat]) => {
          const dimNames = names(data, key);
          return (
            <li
              key={key}
              className="flex flex-wrap items-baseline justify-between gap-2 py-1 text-[12px]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px]">{key}</div>
                {dimNames && dimNames.length > 0 && (
                  <div className="mt-0.5 truncate text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
                    {dimNames.join(" · ")}
                  </div>
                )}
              </div>
              <span className="font-mono text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
                {feat.dtype}
                {feat.shape ? ` ${formatShape(feat.shape)}` : ""}
                {stats[key]?.count !== undefined ? ` · n=${stats[key].count}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function RawJson({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="lr-card overflow-hidden" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer list-none px-4 py-2.5 text-[12px] font-semibold transition-colors hover:bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)]">
        <span className="select-none">
          <span className="mr-2 inline-block w-3 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
            {open ? "▼" : "▶"}
          </span>
          Show raw JSON
        </span>
      </summary>
      <pre className="max-h-96 overflow-auto bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)] px-4 py-3 font-mono text-[11px] leading-relaxed scrollbar-thin">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="lr-card-pad text-[12px] italic text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        {label}
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate text-right",
          mono ? "font-mono" : "",
          small ? "text-[11px]" : "text-[12px]",
        ]
          .filter(Boolean)
          .join(" ")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function VersionBadge({ version }: { version: DatasetMetadataView["version"] }) {
  const cls =
    version === "v3.0"
      ? "lr-badge lr-badge-v3"
      : version === "unknown"
        ? "lr-badge lr-badge-warn"
        : "lr-badge lr-badge-v2";
  return <span className={cls}>{version}</span>;
}

const RANGE_PALETTE = [
  "#5fbcff",
  "#79e08c",
  "#f5a85a",
  "#d186f5",
  "#f56b8c",
  "#f5d56b",
  "#6bf5d2",
  "#a3a3ff",
];

function RangeCard({
  title,
  stats,
  names,
}: {
  title: string;
  stats: FeatureStats;
  names?: string[];
}) {
  const min = stats.min ?? [];
  const max = stats.max ?? [];
  const mean = stats.mean ?? [];
  const std = stats.std ?? [];
  const dims = Math.max(min.length, max.length);
  if (dims === 0) return null;
  return (
    <div className="lr-card-pad">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[12px]">{title}</span>
        <span className="lr-num text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
          {dims} dim{dims === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {Array.from({ length: dims }, (_, i) => (
          <li key={i} className="lr-num grid grid-cols-[110px_1fr_auto] items-center gap-3 text-[11px]">
            <span
              className="truncate font-mono"
              style={{ color: RANGE_PALETTE[i % RANGE_PALETTE.length] }}
            >
              {names?.[i] ?? `[${i}]`}
            </span>
            <RangeBar
              min={min[i]}
              max={max[i]}
              mean={mean[i]}
              color={RANGE_PALETTE[i % RANGE_PALETTE.length]}
            />
            <span className="text-right text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_60%,transparent)]">
              {short(min[i])} → {short(max[i])}
              {std[i] !== undefined && ` · σ ${short(std[i])}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RangeBar({
  min,
  max,
  mean,
  color,
}: {
  min?: number;
  max?: number;
  mean?: number;
  color: string;
}) {
  if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) {
    return <span className="h-2 w-full" />;
  }
  const range = max - min || 1;
  const meanPct = mean !== undefined ? Math.max(0, Math.min(100, ((mean - min) / range) * 100)) : undefined;
  return (
    <span
      className="relative block h-2 w-full rounded-full"
      style={{ background: "color-mix(in srgb, currentColor 12%, transparent)" }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 right-0 rounded-full"
        style={{
          background: `linear-gradient(90deg, color-mix(in srgb, ${color} 0%, transparent), color-mix(in srgb, ${color} 60%, transparent))`,
        }}
      />
      {meanPct !== undefined && (
        <span
          aria-hidden
          className="absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${meanPct}%`, background: color }}
        />
      )}
    </span>
  );
}

// =============================================================
// helpers
// =============================================================

function formatShape(shape: number[]): string {
  return `[${shape.join("·")}]`;
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function short(v?: number): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(1);
  return v.toFixed(2);
}

function prettyKey(key: string): string {
  return key.replace(/^observation\./, "").replace(/^next\./, "");
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function computeLengthStats(lengths: number[]): { min: number; max: number; mean: number } | undefined {
  const filtered = lengths.filter((n) => Number.isFinite(n) && n > 0);
  if (filtered.length === 0) return undefined;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of filtered) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / filtered.length };
}

function buildHistogram(lengths: number[], bins: number) {
  const filtered = lengths.filter((n) => Number.isFinite(n) && n > 0);
  if (filtered.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of filtered) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) {
    const counts = new Array(bins).fill(0);
    counts[Math.floor(bins / 2)] = filtered.length;
    return { counts, min, max };
  }
  const binWidth = range / bins;
  const counts = new Array(bins).fill(0);
  for (const v of filtered) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / binWidth));
    counts[idx] += 1;
  }
  return { counts, min, max };
}

function groupFeatures(features: Record<string, FeatureSpec>): Array<{
  title: string;
  items: Array<[string, FeatureSpec]>;
}> {
  const cameras: Array<[string, FeatureSpec]> = [];
  const observations: Array<[string, FeatureSpec]> = [];
  const actions: Array<[string, FeatureSpec]> = [];
  const events: Array<[string, FeatureSpec]> = [];
  const indices: Array<[string, FeatureSpec]> = [];
  const other: Array<[string, FeatureSpec]> = [];
  for (const entry of Object.entries(features)) {
    const [key, feat] = entry;
    if (feat.dtype === "video" || key.startsWith("observation.images.")) cameras.push(entry);
    else if (key.startsWith("observation.")) observations.push(entry);
    else if (key === "action" || key.startsWith("action.")) actions.push(entry);
    else if (key.startsWith("next.")) events.push(entry);
    else if (
      key === "timestamp" ||
      key === "episode_index" ||
      key === "frame_index" ||
      key === "index" ||
      key === "task_index"
    )
      indices.push(entry);
    else other.push(entry);
  }
  return [
    { title: "Cameras", items: cameras },
    { title: "Observations", items: observations },
    { title: "Actions", items: actions },
    { title: "Events (next.*)", items: events },
    { title: "Indices & timestamps", items: indices },
    { title: "Other", items: other },
  ];
}

function hasAnyStats(stats: Record<string, FeatureStats>): boolean {
  return Object.values(stats).some((s) => Array.isArray(s.min) && Array.isArray(s.max));
}

function collectNamesForKey(data: DatasetMetadataView, key: string): string[] | undefined {
  // We don't currently ship dim names for every feature, so this is a
  // convenience lookup used by the schema rows + range cards.
  const f = data.info.features[key];
  if (!f?.names) return undefined;
  if (Array.isArray(f.names)) return f.names as string[];
  if (typeof f.names === "object") {
    const out: string[] = [];
    for (const v of Object.values(f.names as Record<string, unknown>)) {
      if (Array.isArray(v)) out.push(...(v as string[]));
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}
