interface Props {
  isPlaying: boolean;
  loop: boolean;
  speed: number;
  frame: number;
  totalFrames: number;
  fps: number;
  onPlayPause: () => void;
  onSeek: (frame: number) => void;
  onSpeed: (speed: number) => void;
  onLoopToggle: () => void;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4];

export function TransportBar(props: Props) {
  const { isPlaying, loop, speed, frame, totalFrames, fps, onPlayPause, onSeek, onSpeed, onLoopToggle } = props;
  const max = Math.max(0, totalFrames - 1);
  const clamp = (f: number) => Math.min(max, Math.max(0, f));
  const seconds = frame / Math.max(1, fps);
  const total = max / Math.max(1, fps);

  return (
    <div className="flex flex-wrap items-center gap-3 px-6 py-3">
      <div className="flex items-center gap-1">
        <IconButton title="Jump back 1s (J)" onClick={() => onSeek(clamp(Math.round(frame) - fps))} symbol="⏮" />
        <IconButton title="Previous frame (←)" onClick={() => onSeek(clamp(Math.round(frame) - 1))} symbol="◀" />
        <IconButton title="Play / Pause (Space)" onClick={onPlayPause} symbol={isPlaying ? "⏸" : "▶"} primary />
        <IconButton title="Next frame (→)" onClick={() => onSeek(clamp(Math.round(frame) + 1))} symbol="▶" />
        <IconButton title="Jump forward 1s (L)" onClick={() => onSeek(clamp(Math.round(frame) + fps))} symbol="⏭" />
      </div>

      <SpeedSelector value={speed} onChange={onSpeed} />

      <button
        type="button"
        onClick={onLoopToggle}
        className={loop ? "lr-pill lr-pill-active" : "lr-pill"}
        aria-pressed={loop}
        title="Loop (R)"
      >
        Loop
      </button>

      <div className="ml-auto flex items-baseline gap-4 lr-num text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        <span>
          <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">
            {format(seconds)}
          </span>{" "}
          / {format(total)}
        </span>
        <span>
          frame{" "}
          <span className="text-[color-mix(in_srgb,var(--vscode-foreground)_85%,transparent)]">{Math.round(frame)}</span>{" "}
          / {max}
        </span>
      </div>
    </div>
  );
}

function SpeedSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div role="group" aria-label="Playback speed" className="inline-flex items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_5%,transparent)] p-0.5">
      {SPEEDS.map((s) => {
        const active = s === value;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            aria-pressed={active}
            className={`min-w-[44px] rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ${
              active
                ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]"
                : "text-[color-mix(in_srgb,var(--vscode-foreground)_70%,transparent)] hover:text-[var(--vscode-foreground)]"
            }`}
          >
            {s}×
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  symbol,
  title,
  onClick,
  primary,
}: {
  symbol: string;
  title: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={primary ? "lr-icon-btn lr-icon-btn-primary" : "lr-icon-btn"}
    >
      <span aria-hidden>{symbol}</span>
    </button>
  );
}

function format(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
