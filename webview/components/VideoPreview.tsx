import { useEffect, useRef } from "react";
import type { EpisodePreviewData } from "../../src/types";

interface Props {
  camera: EpisodePreviewData["cameras"][number];
  isPlaying: boolean;
  isFocused: boolean;
  onToggleFocus: () => void;
  onHide: () => void;
  registerVideo: (el: HTMLVideoElement | null) => void;
}

export function VideoPreview({
  camera,
  isPlaying,
  isFocused,
  onToggleFocus,
  onHide,
  registerVideo,
}: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    registerVideo(ref.current);
    return () => registerVideo(null);
  }, [registerVideo]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (isPlaying) {
      void video.play().catch(() => {/* autoplay can fail; ignored */});
    } else {
      video.pause();
    }
  }, [isPlaying]);

  if (!camera.videoUri) {
    return (
      <figure className="lr-card flex h-44 flex-col items-center justify-center gap-1 text-center text-[12px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]">{camera.key}</span>
          <button
            type="button"
            onClick={onHide}
            className="lr-icon-btn"
            title="Hide camera"
            aria-label="Hide camera"
          >
            <span aria-hidden>👁</span>
          </button>
        </div>
        <span>No video file resolved</span>
        {camera.note && <span className="px-3 text-[11px] text-[#f5a85a]">{camera.note}</span>}
      </figure>
    );
  }

  return (
    <figure className="lr-card overflow-hidden">
      <figcaption className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate font-mono text-[11px] text-[color-mix(in_srgb,var(--vscode-foreground)_75%,transparent)]">
          {camera.key}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onHide}
            className="lr-icon-btn"
            title="Hide this camera"
            aria-label="Hide camera"
          >
            <span aria-hidden>👁</span>
          </button>
          <button
            type="button"
            onClick={onToggleFocus}
            className="lr-icon-btn"
            title={isFocused ? "Restore grid" : "Focus this camera"}
            aria-label={isFocused ? "Restore camera grid" : "Focus camera"}
          >
            <span aria-hidden>{isFocused ? "⤡" : "⤢"}</span>
          </button>
        </div>
      </figcaption>
      <div className="bg-black">
        <video
          ref={ref}
          src={camera.videoUri}
          className="block w-full cursor-pointer"
          muted
          playsInline
          controls={false}
          onClick={onToggleFocus}
        />
      </div>
      {camera.note && (
        <div className="border-t border-[var(--lr-divider)] px-3 py-1.5 text-[11px] text-[#f5a85a]">
          {camera.note}
        </div>
      )}
    </figure>
  );
}
