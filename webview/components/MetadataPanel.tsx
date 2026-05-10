import type {
  EpisodePreviewData,
  FeatureSpec,
  FeatureStats,
  TaskInfo,
} from "../../src/types";
import { EpisodeStrip } from "./EpisodeStrip";
import { LengthHistogram } from "./LengthHistogram";

export function MetadataPanel({ data }: { data: EpisodePreviewData }) {
  const info = data.info;
  const lengths = data.episodeLengths;
  const lengthStats = computeLengthStats(lengths);
  const fps = info.fps || 1;
  const totalDurationSec = info.totalFrames / fps;
  const avgEpisodeSec = lengthStats ? lengthStats.mean / fps : undefined;

  const grouped = groupFeatures(info.features);

  return (
    <div className="space-y-7 p-5">
      {/* HERO */}
      <section className="space-y-3">
        <div className="lr-section-label">Dataset</div>
        <div className="grid grid-cols-2 gap-2.5">
          <KpiTile label="Episodes" value={info.totalEpisodes.toLocaleString()} />
          <KpiTile label="Frames" value={info.totalFrames.toLocaleString()} />
          <KpiTile label="Duration" value={formatDuration(totalDurationSec)} />
          <KpiTile
            label="Avg episode"
            value={avgEpisodeSec !== undefined ? `${avgEpisodeSec.toFixed(1)}s` : "—"}
            hint={lengthStats ? `${lengthStats.mean.toFixed(0)} fr` : undefined}
          />
        </div>
        <div className="lr-num flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_60%,transparent)]">
          <span>
            <span className="font-medium text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
              {info.fps}
            </span>{" "}
            fps
          </span>
          {info.robotType && info.robotType !== "unknown" && (
            <span>
              robot{" "}
              <span className="font-medium text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
                {info.robotType}
              </span>
            </span>
          )}
          {info.codebaseVersion && (
            <span>
              codebase{" "}
              <span className="font-mono text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
                {info.codebaseVersion}
              </span>
            </span>
          )}
        </div>
        {data.dataset.repoId && (
          <div className="lr-card-pad text-[12px]">
            <div className="lr-stat-label mb-1">Hugging Face</div>
            <div className="font-mono text-[12px]">🤗 {data.dataset.repoId}</div>
          </div>
        )}
        {data.dataset.root && (
          <div className="text-[10px]">
            <div className="lr-stat-label mb-0.5">Path</div>
            <div className="break-all font-mono text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_70%,transparent)]">
              {data.dataset.root}
            </div>
          </div>
        )}
      </section>

      {/* EPISODE LOCATION */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <div className="lr-section-label">Episode</div>
          <div className="lr-num text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
            #{data.episode.episodeIndex.toString().padStart(4, "0")}
          </div>
        </div>
        <EpisodeStrip
          lengths={lengths}
          currentIndex={data.episode.episodeIndex}
          totalEpisodes={data.totalEpisodes}
        />
        <div className="grid grid-cols-2 gap-2.5">
          <KpiTile
            label="Frames"
            value={data.episode.length ? data.episode.length.toLocaleString() : "—"}
          />
          <KpiTile
            label="Duration"
            value={data.episode.length ? `${(data.episode.length / fps).toFixed(2)}s` : "—"}
          />
        </div>
        {data.episode.frameRange && (
          <Row
            label="Global range"
            value={`${data.episode.frameRange[0].toLocaleString()} – ${data.episode.frameRange[1].toLocaleString()}`}
            mono
          />
        )}
        {data.episode.dataShard && (
          <Row
            label="Data shard"
            value={`chunk-${pad3(data.episode.dataShard.chunkIndex)} · file-${pad3(data.episode.dataShard.fileIndex)}`}
            mono
          />
        )}
      </section>

      {/* TASKS */}
      <section className="space-y-3">
        <div className="lr-section-label">
          Tasks · {data.tasks.length || data.episode.tasks.length || 0}
        </div>
        <TasksBlock tasks={data.tasks} currentEpisodeTasks={data.episode.tasks} />
      </section>

      {/* LENGTH DISTRIBUTION */}
      {lengthStats && lengths.length > 1 && (
        <section className="space-y-3">
          <div className="lr-section-label">Episode length distribution</div>
          <LengthHistogram lengths={lengths} cursorLength={data.episode.length} />
          <div className="lr-num flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
            <span>
              min{" "}
              <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
                {lengthStats.min.toLocaleString()}
              </span>
            </span>
            <span>
              max{" "}
              <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
                {lengthStats.max.toLocaleString()}
              </span>
            </span>
            <span>
              μ{" "}
              <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
                {lengthStats.mean.toFixed(0)}
              </span>
            </span>
          </div>
        </section>
      )}

      {/* SPLITS */}
      {Object.keys(data.splits).length > 0 && (
        <section className="space-y-3">
          <div className="lr-section-label">Splits</div>
          <ul className="space-y-1.5">
            {Object.entries(data.splits).map(([name, [from, to]]) => {
              const isCurrent = name === data.episodeSplit;
              const total = data.totalEpisodes;
              const pct = total > 0 ? Math.round(((to - from) / total) * 100) : 0;
              return (
                <li
                  key={name}
                  className={`lr-card-pad relative overflow-hidden ${
                    isCurrent ? "ring-1 ring-[var(--lr-accent)]" : ""
                  }`}
                >
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${pct}%`,
                      background: "color-mix(in srgb, var(--lr-accent) 8%, transparent)",
                    }}
                  />
                  <div className="relative flex items-baseline justify-between gap-3">
                    <div>
                      <div className="text-[12px] font-semibold">{name}</div>
                      <div className="lr-num mt-0.5 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
                        {from.toLocaleString()}–{to.toLocaleString()} · {(to - from).toLocaleString()} episodes ({pct}%)
                      </div>
                    </div>
                    {isCurrent && <span className="lr-badge lr-badge-v3">current</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* DATASET STATS for state/action */}
      {hasStats(data.stats, "observation.state") || hasStats(data.stats, "action") ? (
        <section className="space-y-3">
          <div className="lr-section-label">Signal ranges</div>
          {(["observation.state", "action", "observation.velocity", "observation.effort", "next.reward"] as const).map(
            (key) => {
              const s = data.stats[key];
              if (!s || !s.min || !s.max) return null;
              const names = collectNames(data, key);
              return <RangeCard key={key} title={prettyKey(key)} stats={s} names={names} />;
            },
          )}
        </section>
      ) : null}

      {/* CAMERAS */}
      <section className="space-y-3">
        <div className="lr-section-label">Cameras · {data.cameras.length}</div>
        {data.cameras.length === 0 ? (
          <Empty>No cameras detected</Empty>
        ) : (
          <ul className="space-y-2">
            {data.cameras.map((cam) => (
              <CameraRow
                key={cam.key}
                camKey={cam.key}
                ready={!!cam.videoUri}
                feature={info.features[cam.key]}
              />
            ))}
          </ul>
        )}
      </section>

      {/* SCHEMA */}
      <section className="space-y-3">
        <div className="lr-section-label">Schema · {Object.keys(info.features).length}</div>
        {grouped.map(({ title, items }) =>
          items.length === 0 ? null : (
            <details key={title} className="lr-card group" open>
              <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-semibold transition-colors hover:bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)]">
                <span className="select-none">
                  <span className="mr-2 inline-block w-3 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)] group-open:rotate-90 transition-transform">
                    ▶
                  </span>
                  {title}
                  <span className="ml-2 text-[10px] font-normal text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
                    {items.length}
                  </span>
                </span>
              </summary>
              <ul className="space-y-1.5 px-3 pb-2.5">
                {items.map(([key, feat]) => (
                  <li
                    key={key}
                    className="flex items-baseline justify-between gap-2 text-[12px]"
                  >
                    <span className="truncate font-mono text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_75%,transparent)]">
                      {key}
                    </span>
                    <span className="font-mono text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
                      {feat.dtype}
                      {feat.shape ? ` ${formatShape(feat.shape)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ),
        )}
      </section>
    </div>
  );
}

// ---------- subcomponents ----------

function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="lr-card-pad">
      <div className="lr-stat-label">{label}</div>
      <div className="lr-stat-value mt-1.5">{value}</div>
      {hint && (
        <div className="mt-1 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_45%,transparent)] lr-num">
          {hint}
        </div>
      )}
    </div>
  );
}

function TasksBlock({
  tasks,
  currentEpisodeTasks,
}: {
  tasks: TaskInfo[];
  currentEpisodeTasks: string[];
}) {
  if (tasks.length === 0 && currentEpisodeTasks.length === 0) {
    return <Empty>No task descriptions</Empty>;
  }
  const list =
    tasks.length > 0
      ? tasks
      : currentEpisodeTasks.map((t, i): TaskInfo => ({ taskIndex: i, task: t }));
  const activeSet = new Set(currentEpisodeTasks);
  const totalCount = list.reduce((acc, t) => acc + (t.episodeCount ?? 0), 0);
  return (
    <ul className="space-y-1.5">
      {list.map((t) => {
        const active = activeSet.has(t.task);
        const pct =
          t.episodeCount !== undefined && totalCount > 0
            ? Math.round((t.episodeCount / totalCount) * 100)
            : undefined;
        return (
          <li
            key={t.taskIndex}
            className={`lr-card-pad relative overflow-hidden ${
              active ? "ring-1 ring-[var(--lr-accent)]" : ""
            }`}
          >
            {/* count bar in background */}
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
                <div className="text-[12px] leading-snug">{t.task}</div>
                <div className="lr-num mt-0.5 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
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
              {active && (
                <span className="lr-badge lr-badge-v3 shrink-0">current</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CameraRow({
  camKey,
  ready,
  feature,
}: {
  camKey: string;
  ready: boolean;
  feature?: FeatureSpec;
}) {
  const shape = feature?.shape;
  const tech = feature?.info ?? {};
  const codec = pickString(tech["video.codec"]);
  const camFps = pickNumber(tech["video.fps"]);
  const pixFmt = pickString(tech["video.pix_fmt"]);
  const resolution =
    shape && shape.length >= 2 ? `${shape[1]}×${shape[0]}` : undefined;
  const isDepth = tech["video.is_depth_map"] === true;
  const hasAudio = tech.has_audio === true;
  return (
    <li className="lr-card-pad">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
          {camKey}
        </span>
        <span
          className={`text-[11px] font-medium ${
            ready ? "text-[#79e08c]" : "text-[#f5a85a]"
          }`}
        >
          {ready ? "● ready" : "○ missing"}
        </span>
      </div>
      <div className="lr-num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        {resolution && <span>{resolution}</span>}
        {camFps !== undefined && <span>{camFps} fps</span>}
        {codec && <span className="font-mono">{codec}</span>}
        {pixFmt && <span className="font-mono">{pixFmt}</span>}
      </div>
      {(isDepth || hasAudio) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {isDepth && <span className="lr-badge">depth</span>}
          {hasAudio && <span className="lr-badge">audio</span>}
        </div>
      )}
    </li>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        {label}
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate text-right text-[12px]",
          mono ? "font-mono" : "",
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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] italic text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)]">
      {children}
    </div>
  );
}

// ---------- helpers ----------

function formatShape(shape: number[]): string {
  return `[${shape.join("·")}]`;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function hasStats(stats: Record<string, FeatureStats>, key: string): boolean {
  const s = stats[key];
  return !!s && Array.isArray(s.min) && Array.isArray(s.max);
}

function prettyKey(key: string): string {
  return key.replace(/^observation\./, "").replace(/^next\./, "");
}

function collectNames(data: EpisodePreviewData, key: string): string[] | undefined {
  if (key === "observation.state") return data.stateNames;
  if (key === "action") return data.actionNames;
  if (key === "observation.velocity") return data.velocityNames;
  if (key === "observation.effort") return data.effortNames;
  if (key === "observation.environment_state") return data.environmentStateNames;
  return undefined;
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
  const dims = Math.max(min.length, max.length);
  if (dims === 0) return null;
  return (
    <div className="lr-card-pad space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px]">{title}</span>
        <span className="lr-num text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
          {dims} dim{dims === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-1">
        {Array.from({ length: dims }, (_, i) => (
          <li key={i} className="lr-num flex items-center gap-2 text-[10px]">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: RANGE_PALETTE[i % RANGE_PALETTE.length] }}
            />
            <span
              className="w-20 shrink-0 truncate text-[10px]"
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
            <span className="shrink-0 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
              {short(min[i])} → {short(max[i])}
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
    return <span className="h-1 flex-1" />;
  }
  const range = max - min || 1;
  const meanPct = mean !== undefined ? Math.max(0, Math.min(100, ((mean - min) / range) * 100)) : undefined;
  return (
    <span
      className="relative h-1.5 flex-1 rounded-full"
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
          className="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${meanPct}%`, background: color }}
        />
      )}
    </span>
  );
}

function short(v?: number): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(1);
  return v.toFixed(2);
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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

function groupFeatures(features: Record<string, FeatureSpec>): Array<{
  title: string;
  items: Array<[string, FeatureSpec]>;
}> {
  const observations: Array<[string, FeatureSpec]> = [];
  const actions: Array<[string, FeatureSpec]> = [];
  const indices: Array<[string, FeatureSpec]> = [];
  const other: Array<[string, FeatureSpec]> = [];
  for (const entry of Object.entries(features)) {
    const [key] = entry;
    if (key.startsWith("observation.")) observations.push(entry);
    else if (key === "action" || key.startsWith("action.")) actions.push(entry);
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
    { title: "Observations", items: observations },
    { title: "Actions", items: actions },
    { title: "Indices & timestamps", items: indices },
    { title: "Other", items: other },
  ];
}
