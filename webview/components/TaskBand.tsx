// Colored band rendering per-frame task_index inside an episode. Adjacent
// frames sharing the same task_index merge into a single segment so the
// band stays visually clean for typical single-task episodes.

interface Props {
  taskIndices: number[];
  totalFrames: number;
  taskLabels?: Record<number, string>;
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

export function TaskBand({ taskIndices, totalFrames, taskLabels }: Props) {
  if (taskIndices.length === 0) return null;
  const segments = mergeSegments(taskIndices);
  // Skip rendering if there's only one task — no value over a static label.
  const distinct = new Set(taskIndices).size;
  if (distinct <= 1) return null;
  const w = 600;
  const h = 16;
  const denom = Math.max(1, taskIndices.length - 1);
  const frameDenom = Math.max(1, totalFrames - 1);

  return (
    <div className="px-6">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="block h-3 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Task index over time"
      >
        {segments.map((seg, i) => {
          const x1 = (seg.from / denom) * (totalFrames - 1) / frameDenom * w;
          const x2 = (seg.to / denom) * (totalFrames - 1) / frameDenom * w;
          const color = PALETTE[seg.task % PALETTE.length];
          const label = taskLabels?.[seg.task] ?? `task ${seg.task}`;
          return (
            <rect
              key={i}
              x={x1}
              y={0}
              width={Math.max(1, x2 - x1)}
              height={h}
              fill={color}
              opacity={0.55}
            >
              <title>{label}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

function mergeSegments(indices: number[]): Array<{ task: number; from: number; to: number }> {
  if (indices.length === 0) return [];
  const out: Array<{ task: number; from: number; to: number }> = [];
  let current = indices[0];
  let from = 0;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== current) {
      out.push({ task: current, from, to: i });
      current = indices[i];
      from = i;
    }
  }
  out.push({ task: current, from, to: indices.length });
  return out;
}
