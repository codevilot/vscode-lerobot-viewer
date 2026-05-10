// Tiny histogram of episode lengths. Used in the metadata panel to give
// users a quick read on how varied the episodes are.

import { useMemo } from "react";

interface Props {
  lengths: number[];
  bins?: number;
  cursorLength?: number;
}

export function LengthHistogram({ lengths, bins = 16, cursorLength }: Props) {
  const data = useMemo(() => buildHistogram(lengths, bins), [lengths, bins]);
  if (!data) return null;
  const { counts, min, max, binWidth } = data;
  const peak = Math.max(...counts, 1);
  const w = 320;
  const h = 60;
  const cursorBin =
    cursorLength !== undefined && binWidth > 0
      ? Math.min(bins - 1, Math.max(0, Math.floor((cursorLength - min) / binWidth)))
      : -1;

  return (
    <div className="space-y-1">
      <svg viewBox={`0 0 ${w} ${h}`} className="block h-12 w-full" preserveAspectRatio="none">
        {counts.map((c, i) => {
          const x = (i / bins) * w;
          const barH = (c / peak) * (h - 4);
          const isCursor = i === cursorBin;
          return (
            <rect
              key={i}
              x={x + 0.5}
              y={h - barH}
              width={w / bins - 1}
              height={barH}
              fill={isCursor ? "var(--lr-accent)" : "currentColor"}
              opacity={isCursor ? 1 : 0.25}
            />
          );
        })}
      </svg>
      <div className="lr-num flex items-baseline justify-between text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        <span>min {min.toLocaleString()}</span>
        <span>max {max.toLocaleString()}</span>
      </div>
    </div>
  );
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
    // All identical — single tall bar in the centre bin.
    const counts = new Array(bins).fill(0);
    counts[Math.floor(bins / 2)] = filtered.length;
    return { counts, min, max, binWidth: 1 };
  }
  const binWidth = range / bins;
  const counts = new Array(bins).fill(0);
  for (const v of filtered) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / binWidth));
    counts[idx] += 1;
  }
  return { counts, min, max, binWidth };
}
