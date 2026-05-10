// Event ticks for boolean RL flags (done / success / truncated).
//
// Each flag becomes a row of vertical lines positioned at frames where the
// flag is 1. Useful for spotting episode termination, success moments, and
// truncations at a glance.

interface Series {
  label: string;
  values: number[]; // 0/1 array, decimated
  color: string;
}

interface Props {
  series: Series[];
  totalFrames: number;
}

export function EventMarkers({ series, totalFrames }: Props) {
  const present = series.filter((s) => s.values.some((v) => v > 0.5));
  if (present.length === 0) return null;
  const w = 600;
  const rowH = 14;
  const h = present.length * rowH + 8;
  const length = present[0]?.values.length ?? 0;
  const denom = Math.max(1, length - 1);
  const frameDenom = Math.max(1, totalFrames - 1);

  return (
    <section className="lr-card-pad mb-3">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[14px] font-semibold">Episode events</h3>
        <span className="text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
          {present.length} signal{present.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="rounded-lg bg-[color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)] p-3">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="block w-full"
          style={{ height: h * 1.4 }}
          preserveAspectRatio="none"
          role="img"
          aria-label="Episode event markers"
        >
          {present.map((s, i) => {
            const y = i * rowH + 4;
            return (
              <g key={s.label}>
                <line
                  x1={0}
                  x2={w}
                  y1={y + rowH / 2}
                  y2={y + rowH / 2}
                  stroke="currentColor"
                  strokeOpacity={0.08}
                />
                {s.values.map((v, t) => {
                  if (v < 0.5) return null;
                  const x = (t / denom) * (totalFrames - 1) / frameDenom * w;
                  return (
                    <line
                      key={t}
                      x1={x}
                      x2={x}
                      y1={y}
                      y2={y + rowH}
                      stroke={s.color}
                      strokeWidth={2}
                    />
                  );
                })}
                <text
                  x={4}
                  y={y + rowH - 3}
                  fontSize={9}
                  fill={s.color}
                  fontFamily="var(--vscode-editor-font-family)"
                >
                  {s.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
