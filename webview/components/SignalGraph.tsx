import { useMemo, useState } from "react";

interface Props {
  title: string;
  series?: number[][];
  names?: string[];
  /** Feature keys present in the dataset, used when no numeric series yet. */
  keys: string[];
  /** Length of the underlying episode in frames (before decimation). */
  totalFrames: number;
  cursorFrame: number;
  /** Optional dataset-wide stats array, indexed by dim. */
  datasetMin?: number[];
  datasetMax?: number[];
  datasetMean?: number[];
}

const PALETTE = [
  "#5fbcff",
  "#79e08c",
  "#f5a85a",
  "#d186f5",
  "#f56b8c",
  "#f5d56b",
  "#6bf5d2",
  "#a3a3ff",
];

interface DimStats {
  min: number;
  max: number;
  mean: number;
}

export function SignalGraph({
  title,
  series,
  names,
  keys,
  totalFrames,
  cursorFrame,
  datasetMin,
  datasetMax,
  datasetMean,
}: Props) {
  const placeholder = !series || series.length === 0;
  const dims = series?.[0]?.length ?? 0;
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());

  const stats = useMemo<DimStats[]>(() => {
    if (!series || series.length === 0) return [];
    return computeStats(series, dims);
  }, [series, dims]);

  const cursorValues =
    series && series.length > 0 ? sampleAtFrame(series, cursorFrame, totalFrames) : undefined;

  const toggleDim = (i: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <section className="lr-card-pad mb-3">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        <span className="text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)] lr-num">
          {dims > 0 ? `${dims - hidden.size}/${dims} visible` : "—"}
        </span>
      </header>
      <div className="rounded-lg bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)] p-3">
        {placeholder ? (
          <PlaceholderGraph keys={keys} />
        ) : (
          <Sparklines
            series={series!}
            hidden={hidden}
            totalFrames={totalFrames}
            cursorFrame={cursorFrame}
          />
        )}
      </div>
      {!placeholder && (
        <DimLegend
          dims={dims}
          names={names}
          stats={stats}
          cursorValues={cursorValues}
          hidden={hidden}
          onToggle={toggleDim}
          datasetMin={datasetMin}
          datasetMax={datasetMax}
          datasetMean={datasetMean}
        />
      )}
    </section>
  );
}

function DimLegend({
  dims,
  names,
  stats,
  cursorValues,
  hidden,
  onToggle,
  datasetMin,
  datasetMax,
  datasetMean,
}: {
  dims: number;
  names?: string[];
  stats: DimStats[];
  cursorValues?: number[];
  hidden: Set<number>;
  onToggle: (i: number) => void;
  datasetMin?: number[];
  datasetMax?: number[];
  datasetMean?: number[];
}) {
  return (
    <ul className="mt-3 grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: dims }, (_, i) => {
        const isHidden = hidden.has(i);
        const color = PALETTE[i % PALETTE.length];
        const label = names?.[i] ?? `[${i}]`;
        const cursor = cursorValues?.[i];
        const stat = stats[i];
        return (
          <li key={i}>
            <button
              type="button"
              onClick={() => onToggle(i)}
              aria-pressed={!isHidden}
              className={`group flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left lr-num transition-colors ${
                isHidden
                  ? "opacity-40"
                  : "hover:bg-[color-mix(in_srgb,var(--vscode-foreground)_8%,transparent)]"
              }`}
              title={`${label} · click to ${isHidden ? "show" : "hide"}`}
            >
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: isHidden ? "transparent" : color, border: `1.5px solid ${color}` }}
              />
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px]"
                style={{ color: isHidden ? undefined : color }}
              >
                {label}
              </span>
              <span className="w-14 shrink-0 text-right text-[12px] font-semibold tabular-nums">
                {cursor !== undefined ? formatValue(cursor) : "—"}
              </span>
              <DimRangeBar
                value={cursor}
                dsMin={datasetMin?.[i]}
                dsMax={datasetMax?.[i]}
                dsMean={datasetMean?.[i]}
                fallbackStat={stat}
                color={color}
              />
              {stat && (
                <span className="hidden shrink-0 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_50%,transparent)] xl:inline">
                  μ{" "}
                  {formatValue(
                    datasetMean?.[i] !== undefined ? datasetMean[i] : stat.mean,
                  )}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Tiny range bar showing where the current value falls between dataset min
 * and max. Falls back to per-episode stats when dataset stats aren't given.
 */
function DimRangeBar({
  value,
  dsMin,
  dsMax,
  dsMean,
  fallbackStat,
  color,
}: {
  value?: number;
  dsMin?: number;
  dsMax?: number;
  dsMean?: number;
  fallbackStat?: DimStats;
  color: string;
}) {
  const min = dsMin ?? fallbackStat?.min;
  const max = dsMax ?? fallbackStat?.max;
  const mean = dsMean ?? fallbackStat?.mean;
  if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) {
    return <span className="hidden h-1.5 w-16 lg:inline-block" />;
  }
  const range = max - min || 1;
  const pct = (v?: number) =>
    v === undefined || !Number.isFinite(v) ? null : Math.max(0, Math.min(100, ((v - min) / range) * 100));
  const valuePct = pct(value);
  const meanPct = pct(mean);
  return (
    <span
      className="relative hidden h-1.5 w-16 shrink-0 rounded-full lg:inline-block"
      style={{ background: "color-mix(in srgb, currentColor 12%, transparent)" }}
      title={`min ${formatValue(min)} · max ${formatValue(max)}${mean !== undefined ? ` · μ ${formatValue(mean)}` : ""}`}
    >
      {meanPct !== null && (
        <span
          aria-hidden
          className="absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 opacity-50"
          style={{ left: `${meanPct}%`, background: color }}
        />
      )}
      {valuePct !== null && (
        <span
          aria-hidden
          className="absolute top-1/2 block h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: color, boxShadow: "0 0 0 2px var(--vscode-editor-background)" }}
        />
      )}
    </span>
  );
}

function PlaceholderGraph({ keys }: { keys: string[] }) {
  return (
    <div className="flex h-24 flex-col items-center justify-center text-center text-[11px] text-vscode-muted">
      <span>No numeric series loaded.</span>
      <span className="mt-0.5 italic">
        {keys.length > 0
          ? `Will visualize ${keys.length} feature(s) once parquet decoding finishes.`
          : "No matching features in dataset."}
      </span>
    </div>
  );
}

function Sparklines({
  series,
  hidden,
  totalFrames,
  cursorFrame,
}: {
  series: number[][];
  hidden: Set<number>;
  totalFrames: number;
  cursorFrame: number;
}) {
  const dims = series[0]?.length ?? 0;
  const length = series.length;
  const width = 600;
  const height = 80;
  const [hover, setHover] = useState<{ x: number; frame: number; values: number[] } | null>(null);

  const paths = useMemo(() => {
    if (length < 2 || dims === 0) return [];
    const result: { d: string; color: string; dim: number }[] = [];
    for (let dim = 0; dim < dims; dim++) {
      if (hidden.has(dim)) continue;
      let min = Infinity;
      let max = -Infinity;
      for (let t = 0; t < length; t++) {
        const v = series[t][dim];
        if (Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      const range = max - min || 1;
      const parts: string[] = [];
      for (let t = 0; t < length; t++) {
        const x = (t / (length - 1)) * width;
        const v = series[t][dim];
        const y = Number.isFinite(v) ? height - ((v - min) / range) * height : height / 2;
        parts.push(`${t === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
      }
      result.push({ d: parts.join(" "), color: PALETTE[dim % PALETTE.length], dim });
    }
    return result;
  }, [series, hidden, dims, length]);

  const denom = Math.max(1, totalFrames - 1);
  const cursorX = Math.min(width, Math.max(0, (cursorFrame / denom) * width));

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const xVb = (xPx / rect.width) * width;
    const t = Math.min(length - 1, Math.max(0, Math.round((xVb / width) * (length - 1))));
    const frame = Math.round((t / (length - 1)) * Math.max(1, totalFrames - 1));
    const values = series[t].slice();
    setHover({ x: xVb, frame, values });
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Signal graph"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {paths.map((p) => (
          <path
            key={p.dim}
            d={p.d}
            stroke={p.color}
            fill="none"
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          x1={cursorX}
          x2={cursorX}
          y1={0}
          y2={height}
          stroke="var(--vscode-focusBorder)"
          strokeWidth={1}
        />
        {hover && (
          <line
            x1={hover.x}
            x2={hover.x}
            y1={0}
            y2={height}
            stroke="currentColor"
            strokeOpacity={0.35}
            strokeDasharray="2 3"
            strokeWidth={1}
          />
        )}
      </svg>
      {hover && (
        <div
          className="lr-num pointer-events-none absolute top-0 z-10 max-w-[220px] rounded-md border border-[var(--lr-card-border)] bg-[var(--vscode-editor-background)] px-2 py-1 text-[10px] shadow-lg"
          style={{
            left: `clamp(0px, calc(${(hover.x / width) * 100}% - 50px), calc(100% - 220px))`,
          }}
        >
          <div className="text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
            frame {hover.frame}
          </div>
          <div className="mt-0.5 grid grid-cols-2 gap-x-2">
            {hover.values.map((v, i) => (
              <div key={i} className="flex items-center gap-1 truncate">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: PALETTE[i % PALETTE.length] }}
                />
                <span className="truncate font-mono">{formatValue(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function computeStats(series: number[][], dims: number): DimStats[] {
  const out: DimStats[] = [];
  for (let dim = 0; dim < dims; dim++) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    for (const row of series) {
      const v = row[dim];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n++;
    }
    out.push({
      min: n === 0 ? NaN : min,
      max: n === 0 ? NaN : max,
      mean: n === 0 ? NaN : sum / n,
    });
  }
  return out;
}

function sampleAtFrame(series: number[][], frame: number, totalFrames: number): number[] | undefined {
  if (series.length === 0) return undefined;
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
