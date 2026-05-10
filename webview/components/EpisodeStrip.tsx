// Compact strip showing where the current episode falls within the dataset.
// Each episode renders as a vertical bar whose height is proportional to
// the episode length; the active one gets the accent color.

interface Props {
  lengths: number[];
  currentIndex: number;
  totalEpisodes: number;
}

export function EpisodeStrip({ lengths, currentIndex, totalEpisodes }: Props) {
  if (lengths.length === 0) return null;
  const maxLen = Math.max(1, ...lengths.filter(Number.isFinite));
  const w = 320;
  const h = 56;
  const padX = 0;
  const innerW = w - 2 * padX;
  const denom = Math.max(1, lengths.length - 1);

  return (
    <div className="space-y-2">
      <div className="lr-num flex items-baseline justify-between text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        <span>Episode {currentIndex.toString().padStart(4, "0")}</span>
        <span>of {totalEpisodes.toLocaleString()}</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="block h-12 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Episode position within dataset"
      >
        {lengths.map((len, i) => {
          const x = padX + (i / denom) * innerW;
          const barH = ((Math.max(0, len) || maxLen * 0.05) / maxLen) * (h - 4);
          const active = i === currentIndex;
          return (
            <rect
              key={i}
              x={x}
              y={h - barH}
              width={Math.max(0.6, innerW / lengths.length - 0.5)}
              height={barH}
              fill={active ? "var(--lr-accent)" : "currentColor"}
              opacity={active ? 1 : 0.18}
              shapeRendering="crispEdges"
            />
          );
        })}
        <line
          x1={padX + (currentIndex / denom) * innerW}
          x2={padX + (currentIndex / denom) * innerW}
          y1={0}
          y2={h}
          stroke="var(--lr-accent)"
          strokeWidth={1}
          strokeDasharray="2 2"
          opacity={0.4}
        />
      </svg>
    </div>
  );
}
