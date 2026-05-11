// Two-column mini-chart grid: OBSERVATION.STATE on the left,
// ACTION on the right. One compact row per dimension with the
// per-frame line and a colored band underneath highlighting where
// |state - action| is large relative to the dim's stddev. Same band
// renders behind both columns so the eye can lock onto regions of
// tracking error at a glance.

import { useMemo } from "react";

interface Props {
  stateSeries?: number[][];
  actionSeries?: number[][];
  stateNames?: string[];
  actionNames?: string[];
  totalFrames: number;
  cursorFrame: number;
  /** Dataset-wide per-dim stddev, when available, for diff-band normalization. */
  stateStd?: number[];
  actionStd?: number[];
  onSeek?: (frame: number) => void;
}

const STATE_COLOR = "#5fbcff";
const ACTION_COLOR = "#f5a85a";
// Olive (moderate tracking error, ≥1σ) → red (large error, ≥3σ).
// Same band paints behind both columns at matching x-ranges.
const DIFF_LOW = "rgba(176, 152, 78, 0.36)";
const DIFF_HIGH = "rgba(214, 80, 92, 0.48)";

const CHART_VB_W = 400;
const CHART_VB_H = 36;

export function SignalGrid({
  stateSeries,
  actionSeries,
  stateNames,
  actionNames,
  totalFrames,
  cursorFrame,
  stateStd,
  actionStd,
  onSeek,
}: Props) {
  const stateDims = stateSeries?.[0]?.length ?? 0;
  const actionDims = actionSeries?.[0]?.length ?? 0;
  const dims = Math.max(stateDims, actionDims);

  // Per-dim diff-level run intervals, used to paint the colored bands.
  const diffRuns = useMemo(
    () => computeDiffRuns(stateSeries, actionSeries, dims, stateStd, actionStd),
    [stateSeries, actionSeries, dims, stateStd, actionStd],
  );

  const stateCursor = useMemo(
    () => sampleAt(stateSeries, cursorFrame, totalFrames),
    [stateSeries, cursorFrame, totalFrames],
  );
  const actionCursor = useMemo(
    () => sampleAt(actionSeries, cursorFrame, totalFrames),
    [actionSeries, cursorFrame, totalFrames],
  );

  if (dims === 0) {
    return (
      <div className="rounded-xl border border-dashed border-vscode-border p-6 text-center text-[12px] text-vscode-muted">
        No state or action signals in this episode.
      </div>
    );
  }

  return (
    <div className="pt-2">
      <div className="mb-1 grid grid-cols-2 gap-x-3">
        <ColumnHeader label="OBSERVATION.STATE" count={stateDims} />
        <ColumnHeader label="ACTION" count={actionDims} />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0">
        {Array.from({ length: dims }).map((_, i) => (
          <DimRowPair
            key={i}
            dim={i}
            stateSeries={stateSeries}
            actionSeries={actionSeries}
            stateLabel={stateNames?.[i] ?? `state[${i}]`}
            actionLabel={actionNames?.[i] ?? `action[${i}]`}
            stateValue={stateCursor?.[i]}
            actionValue={actionCursor?.[i]}
            totalFrames={totalFrames}
            cursorFrame={cursorFrame}
            diffRuns={diffRuns[i]}
            onSeek={onSeek}
            stateHidden={i >= stateDims}
            actionHidden={i >= actionDims}
          />
        ))}
      </div>
    </div>
  );
}

function ColumnHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold tracking-wider text-[color-mix(in_srgb,var(--vscode-foreground)_60%,transparent)]">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-[9px] opacity-60">
          ▼
        </span>
        {label}
      </span>
      <span className="text-[10px] tabular-nums opacity-70">{count}</span>
    </div>
  );
}

function DimRowPair(props: {
  dim: number;
  stateSeries?: number[][];
  actionSeries?: number[][];
  stateLabel: string;
  actionLabel: string;
  stateValue?: number;
  actionValue?: number;
  totalFrames: number;
  cursorFrame: number;
  diffRuns: DiffRun[];
  onSeek?: (frame: number) => void;
  stateHidden: boolean;
  actionHidden: boolean;
}) {
  return (
    <>
      <DimCell
        label={props.stateLabel}
        labelColor={STATE_COLOR}
        series={props.stateSeries}
        dim={props.dim}
        value={props.stateValue}
        color={STATE_COLOR}
        totalFrames={props.totalFrames}
        cursorFrame={props.cursorFrame}
        diffRuns={props.diffRuns}
        onSeek={props.onSeek}
        hidden={props.stateHidden}
      />
      <DimCell
        label={props.actionLabel}
        labelColor={ACTION_COLOR}
        series={props.actionSeries}
        dim={props.dim}
        value={props.actionValue}
        color={ACTION_COLOR}
        totalFrames={props.totalFrames}
        cursorFrame={props.cursorFrame}
        diffRuns={props.diffRuns}
        onSeek={props.onSeek}
        hidden={props.actionHidden}
      />
    </>
  );
}

function DimCell({
  label,
  labelColor,
  series,
  dim,
  value,
  color,
  totalFrames,
  cursorFrame,
  diffRuns,
  onSeek,
  hidden,
}: {
  label: string;
  labelColor: string;
  series?: number[][];
  dim: number;
  value?: number;
  color: string;
  totalFrames: number;
  cursorFrame: number;
  diffRuns: DiffRun[];
  onSeek?: (frame: number) => void;
  hidden: boolean;
}) {
  if (hidden) return <div className="h-[60px]" />;

  return (
    <div className="group relative mb-1.5 overflow-hidden rounded-md bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)]">
      <div className="flex items-baseline justify-between px-2.5 pt-1.5 pb-1 lr-num">
        <span className="font-mono text-[12px]" style={{ color: labelColor }}>
          {label}
        </span>
        <span className="text-[12px] tabular-nums text-[color-mix(in_srgb,var(--vscode-foreground)_80%,transparent)]">
          {value !== undefined ? formatValue(value) : "—"}
        </span>
      </div>
      <MiniChart
        series={series}
        dim={dim}
        color={color}
        totalFrames={totalFrames}
        cursorFrame={cursorFrame}
        diffRuns={diffRuns}
        onSeek={onSeek}
      />
    </div>
  );
}

function MiniChart({
  series,
  dim,
  color,
  totalFrames,
  cursorFrame,
  diffRuns,
  onSeek,
}: {
  series?: number[][];
  dim: number;
  color: string;
  totalFrames: number;
  cursorFrame: number;
  diffRuns: DiffRun[];
  onSeek?: (frame: number) => void;
}) {
  const w = CHART_VB_W;
  const h = CHART_VB_H;
  const path = useMemo(() => {
    if (!series || series.length < 2) return "";
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t < series.length; t++) {
      const v = series[t][dim];
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
    const range = max - min || 1;
    const len = series.length;
    const parts: string[] = [];
    for (let t = 0; t < len; t++) {
      const x = (t / (len - 1)) * w;
      const v = series[t][dim];
      const y = Number.isFinite(v) ? h - ((v - min) / range) * (h - 4) - 2 : h / 2;
      parts.push(`${t === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return parts.join(" ");
  }, [series, dim, w, h]);

  const denom = Math.max(1, totalFrames - 1);
  const cursorX = Math.min(w, Math.max(0, (cursorFrame / denom) * w));

  function onClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!onSeek || totalFrames <= 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.round(ratio * (totalFrames - 1)));
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block h-[34px] w-full cursor-crosshair"
      onClick={onClick}
      role="img"
      aria-hidden
    >
      {diffRuns.map((r, i) => {
        const x1 = (r.start / denom) * w;
        const x2 = (r.end / denom) * w;
        return (
          <rect
            key={i}
            x={x1}
            y={0}
            width={Math.max(1, x2 - x1)}
            height={h}
            fill={r.level === 2 ? DIFF_HIGH : DIFF_LOW}
          />
        );
      })}
      {path && (
        <path
          d={path}
          stroke={color}
          fill="none"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <line
        x1={cursorX}
        x2={cursorX}
        y1={0}
        y2={h}
        stroke="var(--vscode-focusBorder)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        opacity={0.7}
      />
    </svg>
  );
}

// ----- diff bands -----

interface DiffRun {
  start: number;
  end: number;
  level: 1 | 2;
}

function computeDiffRuns(
  state: number[][] | undefined,
  action: number[][] | undefined,
  dims: number,
  stateStd?: number[],
  actionStd?: number[],
): DiffRun[][] {
  if (!state || !action || state.length === 0 || action.length === 0) {
    return Array.from({ length: dims }, () => []);
  }
  const len = Math.min(state.length, action.length);
  if (len < 2) return Array.from({ length: dims }, () => []);

  const out: DiffRun[][] = [];
  for (let dim = 0; dim < dims; dim++) {
    if (
      dim >= (state[0]?.length ?? 0) ||
      dim >= (action[0]?.length ?? 0)
    ) {
      out.push([]);
      continue;
    }
    const std = pickStd(stateStd?.[dim], actionStd?.[dim], state, action, dim);
    if (!Number.isFinite(std) || std <= 0) {
      out.push([]);
      continue;
    }
    const levels: number[] = new Array(len);
    for (let t = 0; t < len; t++) {
      const s = state[t][dim];
      const a = action[t][dim];
      if (!Number.isFinite(s) || !Number.isFinite(a)) {
        levels[t] = 0;
        continue;
      }
      const r = Math.abs(s - a) / std;
      levels[t] = r >= 3 ? 2 : r >= 1 ? 1 : 0;
    }
    out.push(runsOf(levels));
  }
  return out;
}

function pickStd(
  dsStateStd: number | undefined,
  dsActionStd: number | undefined,
  state: number[][],
  action: number[][],
  dim: number,
): number {
  // Prefer dataset-wide stats when present; otherwise compute std from
  // this episode's state series (action would work too, they're
  // usually close in magnitude for tracking control).
  if (dsStateStd && Number.isFinite(dsStateStd) && dsStateStd > 0) return dsStateStd;
  if (dsActionStd && Number.isFinite(dsActionStd) && dsActionStd > 0) return dsActionStd;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let t = 0; t < state.length; t++) {
    const v = state[t][dim];
    if (!Number.isFinite(v)) continue;
    sum += v;
    sumSq += v * v;
    n++;
  }
  for (let t = 0; t < action.length; t++) {
    const v = action[t][dim];
    if (!Number.isFinite(v)) continue;
    sum += v;
    sumSq += v * v;
    n++;
  }
  if (n < 2) return NaN;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return Math.sqrt(variance);
}

function runsOf(values: number[]): DiffRun[] {
  if (values.length === 0) return [];
  const runs: DiffRun[] = [];
  let runStart = 0;
  let cur = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== cur) {
      if (cur > 0) runs.push({ start: runStart, end: i, level: cur as 1 | 2 });
      runStart = i;
      cur = values[i];
    }
  }
  if (cur > 0) runs.push({ start: runStart, end: values.length, level: cur as 1 | 2 });
  return runs;
}

function sampleAt(
  series: number[][] | undefined,
  frame: number,
  totalFrames: number,
): number[] | undefined {
  if (!series || series.length === 0) return undefined;
  const denom = Math.max(1, totalFrames - 1);
  const idx = Math.min(
    series.length - 1,
    Math.max(0, Math.round((frame / denom) * (series.length - 1))),
  );
  return series[idx];
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(2);
  return v.toFixed(3);
}
