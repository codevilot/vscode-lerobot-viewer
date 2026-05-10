import type { ChangeEvent, KeyboardEvent } from "react";

interface Props {
  frame: number;
  totalFrames: number;
  fps: number;
  onChange: (frame: number) => void;
}

export function Timeline({ frame, totalFrames, fps, onChange }: Props) {
  const max = Math.max(1, totalFrames - 1);

  const handleSlider = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(Number(e.target.value));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "j") {
      e.preventDefault();
      onChange(Math.max(0, frame - fps));
    } else if (e.key === "l") {
      e.preventDefault();
      onChange(Math.min(max, frame + fps));
    }
  };

  return (
    <div className="px-6 pb-1 pt-0">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.round(frame)}
        onChange={handleSlider}
        onKeyDown={handleKeyDown}
        aria-label="Episode timeline scrubber"
        className="lr-range"
      />
    </div>
  );
}
