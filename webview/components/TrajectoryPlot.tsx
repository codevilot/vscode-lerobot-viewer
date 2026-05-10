// Phase / trajectory plot.
//
// For 2-dim signals (e.g. a 2-motor arm), plotting dim0 against dim1 reveals
// loops, oscillations, and reachable workspace at a glance — the kind of
// view Rerun's 2D scene gives you. We highlight the current cursor frame so
// it stays in sync with the timeline scrubber.

interface Props {
  title: string;
  series?: number[][];
  names?: string[];
  totalFrames: number;
  cursorFrame: number;
}

export function TrajectoryPlot({ title, series, names, totalFrames, cursorFrame }: Props) {
  if (!series || series.length === 0) return null;
  const dims = series[0]?.length ?? 0;
  if (dims < 2) return null;

  // Use only the first two dims; higher-dim plots get noisy and need a real
  // dimensionality reduction story (out of scope for this MVP).
  const xName = names?.[0] ?? "dim 0";
  const yName = names?.[1] ?? "dim 1";

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const row of series) {
    const x = row[0];
    const y = row[1];
    if (Number.isFinite(x)) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
    if (Number.isFinite(y)) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return null;
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const w = 240;
  const h = 240;
  const pad = 12;

  const project = (x: number, y: number): [number, number] => [
    pad + ((x - xMin) / xRange) * (w - 2 * pad),
    h - pad - ((y - yMin) / yRange) * (h - 2 * pad),
  ];

  const pathD = series
    .map((row, i) => {
      const [px, py] = project(row[0], row[1]);
      return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");

  const denom = Math.max(1, totalFrames - 1);
  const cursorIdx = Math.min(
    series.length - 1,
    Math.max(0, Math.round((cursorFrame / denom) * (series.length - 1))),
  );
  const cursor = series[cursorIdx];
  const [cx, cy] = project(cursor[0], cursor[1]);

  return (
    <section className="lr-card-pad">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[14px] font-semibold">{title} trajectory</h3>
        <span className="font-mono text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
          {xName} × {yName}
        </span>
      </header>
      <div className="rounded-lg bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)] p-2">
        <svg width={w} height={h} role="img" aria-label={`${title} trajectory plot`}>
          <rect
            x={pad}
            y={pad}
            width={w - 2 * pad}
            height={h - 2 * pad}
            fill="none"
            stroke="color-mix(in srgb, currentColor 12%, transparent)"
          />
          <path d={pathD} fill="none" stroke="var(--lr-accent)" strokeWidth={1.4} />
          <circle
            cx={cx}
            cy={cy}
            r={5}
            fill="var(--lr-accent)"
            stroke="var(--vscode-editor-background)"
            strokeWidth={2}
          />
          <text x={pad} y={h - 2} fontSize={10} fill="currentColor" opacity="0.55">
            {xName}
          </text>
          <text x={2} y={pad + 8} fontSize={10} fill="currentColor" opacity="0.55">
            {yName}
          </text>
        </svg>
      </div>
    </section>
  );
}
