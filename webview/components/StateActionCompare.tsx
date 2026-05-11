// Per-dim state vs action overlay.
//
// User feedback: "action과 states 비교가 편했으면 좋겠어요" — comparing the
// commanded action against the achieved state, dim by dim, is *the* canonical
// robotics question. The default view stacks State and Action as two
// separate cards, which makes the user mentally line up dims across cards.
// Compare mode replaces both cards with a grid of mini-charts, one per
// (state-dim, action-dim) pair, sharing axes so tracking error is visually
// obvious.

import { useMemo } from "react";

const STATE_COLOR = "#5fbcff";
const ACTION_COLOR = "#f5a85a";

interface Props {
  state: number[][];
  action: number[][];
  stateNames?: string[];
  actionNames?: string[];
  totalFrames: number;
  cursorFrame: number;
  chartHeight: number;
}

export function StateActionCompare({
  state,
  action,
  stateNames,
  actionNames,
  totalFrames,
  cursorFrame,
  chartHeight,
}: Props) {
  const stateDims = state[0]?.length ?? 0;
  const actionDims = action[0]?.length ?? 0;
  const dims = Math.min(stateDims, actionDims);
  const dimMismatch = stateDims !== actionDims;

  return (
    <section className="lr-card-pad">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-semibold">Compare · state vs action</h3>
        <div className="flex items-center gap-3 text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
          <LegendSwatch label="state" color={STATE_COLOR} />
          <LegendSwatch label="action" color={ACTION_COLOR} />
        </div>
      </header>
      {dimMismatch && (
        <div className="mb-2 rounded-md px-2 py-1.5 text-[11px]" style={{
          background: "color-mix(in srgb, #f5a85a 12%, transparent)",
          color: "#f5a85a",
        }}>
          state has {stateDims} dim{stateDims === 1 ? "" : "s"}, action has {actionDims}.
          Showing the {dims} pair{dims === 1 ? "" : "s"} that line up by index.
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {Array.from({ length: dims }, (_, i) => (
          <li key={i}>
            <ComparePair
              dim={i}
              label={pairLabel(stateNames?.[i], actionNames?.[i], i)}
              state={state}
              action={action}
              totalFrames={totalFrames}
              cursorFrame={cursorFrame}
              chartHeight={chartHeight}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function pairLabel(stateName: string | undefined, actionName: string | undefined, idx: number): string {
  if (stateName && actionName && stateName === actionName) return stateName;
  if (stateName && actionName) return `${stateName} ↔ ${actionName}`;
  return stateName ?? actionName ?? `[${idx}]`;
}

function LegendSwatch({ label, color }: { label: string; color: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span className="lr-num">{label}</span>
    </span>
  );
}

function ComparePair({
  dim,
  label,
  state,
  action,
  totalFrames,
  cursorFrame,
  chartHeight,
}: {
  dim: number;
  label: string;
  state: number[][];
  action: number[][];
  totalFrames: number;
  cursorFrame: number;
  chartHeight: number;
}) {
  const stateSeries = useMemo(() => state.map((row) => row[dim]), [state, dim]);
  const actionSeries = useMemo(() => action.map((row) => row[dim]), [action, dim]);
  const { min, max } = useMemo(() => sharedRange(stateSeries, actionSeries), [stateSeries, actionSeries]);

  const length = Math.max(stateSeries.length, actionSeries.length);
  const width = 600;
  const height = chartHeight;
  const denom = Math.max(1, length - 1);
  const cursorIdx = Math.min(length - 1, Math.max(0, Math.round((cursorFrame / Math.max(1, totalFrames - 1)) * denom)));
  const cursorX = (cursorIdx / denom) * width;

  const statePath = pathFor(stateSeries, min, max, width, height);
  const actionPath = pathFor(actionSeries, min, max, width, height);
  const stateNow = stateSeries[cursorIdx];
  const actionNow = actionSeries[cursorIdx];
  const error = Number.isFinite(stateNow) && Number.isFinite(actionNow) ? actionNow - stateNow : undefined;

  return (
    <div className="rounded-lg" style={{ background: "color-mix(in srgb, var(--vscode-foreground) 4%, transparent)" }}>
      <div className="flex items-baseline justify-between px-3 pt-2">
        <span className="truncate font-mono text-[12px]" title={label}>{label}</span>
        {error !== undefined && (
          <span
            className="text-[10px] tabular-nums"
            style={{ color: Math.abs(error) > (max - min) * 0.05 ? "#f56b8c" : "color-mix(in srgb, var(--vscode-foreground) 55%, transparent)" }}
            title="action − state at the current frame"
          >
            Δ {formatNum(error)}
          </span>
        )}
      </div>
      <div className="px-3 pt-1">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          style={{ height: `${height}px` }}
          preserveAspectRatio="none"
          role="img"
          aria-label={`State vs action for ${label}`}
        >
          {actionPath && (
            <path d={actionPath} stroke={ACTION_COLOR} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          )}
          {statePath && (
            <path d={statePath} stroke={STATE_COLOR} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          )}
          <line x1={cursorX} x2={cursorX} y1={0} y2={height} stroke="var(--vscode-focusBorder)" strokeWidth={1} />
        </svg>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3 pb-2 pt-1">
        <ValueCell color={STATE_COLOR} label="state" value={stateNow} />
        <ValueCell color={ACTION_COLOR} label="action" value={actionNow} />
      </div>
    </div>
  );
}

function ValueCell({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-[10px] uppercase tracking-wide text-[color-mix(in_srgb,var(--vscode-foreground)_45%,transparent)]">
        {label}
      </span>
      <span className="ml-auto text-[16px] font-semibold tabular-nums" style={{ color }}>
        {Number.isFinite(value) ? formatNum(value) : "—"}
      </span>
    </div>
  );
}

function sharedRange(a: number[], b: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of a) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
  for (const v of b) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 0.5, max: max + 0.5 };
  return { min, max };
}

function pathFor(series: number[], min: number, max: number, width: number, height: number): string | undefined {
  if (series.length < 2) return undefined;
  const range = max - min || 1;
  const parts: string[] = [];
  for (let t = 0; t < series.length; t++) {
    const x = (t / (series.length - 1)) * width;
    const v = series[t];
    const y = Number.isFinite(v) ? height - ((v - min) / range) * height : height / 2;
    parts.push(`${t === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return parts.join(" ");
}

function formatNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(3);
  return v.toFixed(4);
}
