// Window-level keyboard shortcuts for the episode preview. Skipped when
// the user is typing in a form field.

import { useEffect } from "react";
import type { PlaybackController } from "./usePlayback";

export function usePlaybackShortcuts(
  controller: PlaybackController,
  fps: number,
  totalFrames: number,
): void {
  const { frame, seek, setIsPlaying, setLoop } = controller;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const max = Math.max(0, totalFrames - 1);
      switch (e.key) {
        case " ":
          e.preventDefault();
          setIsPlaying((p) => !p);
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(Math.round(frame) - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(Math.round(frame) + 1);
          break;
        case "j":
          e.preventDefault();
          seek(Math.round(frame) - fps);
          break;
        case "l":
          e.preventDefault();
          seek(Math.round(frame) + fps);
          break;
        case "k":
          e.preventDefault();
          setIsPlaying(false);
          break;
        case "r":
          e.preventDefault();
          setLoop((p) => !p);
          break;
        case "Home":
          e.preventDefault();
          seek(0);
          break;
        case "End":
          e.preventDefault();
          seek(max);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame, fps, totalFrames, seek, setIsPlaying, setLoop]);
}
