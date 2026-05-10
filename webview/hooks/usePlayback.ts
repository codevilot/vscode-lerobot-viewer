// Playback controller hook.
//
// Owns play/pause, speed, loop, and the smooth-cursor frame value driven
// by a 60fps requestAnimationFrame loop that polls video.currentTime.
// Exposes a `seek` callback that pushes scrubs back into all videos.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface PlaybackState {
  frame: number;
  isPlaying: boolean;
  speed: number;
  loop: boolean;
}

export interface PlaybackController extends PlaybackState {
  setIsPlaying: (next: boolean | ((prev: boolean) => boolean)) => void;
  setSpeed: (next: number) => void;
  setLoop: (next: boolean | ((prev: boolean) => boolean)) => void;
  seek: (target: number) => void;
}

export function usePlayback(
  videoRefs: RefObject<Map<string, HTMLVideoElement>>,
  fps: number,
  totalFrames: number,
): PlaybackController {
  const [frame, setFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);

  // Refs avoid re-binding the rAF loop on every render.
  const fpsRef = useRef(fps);
  const totalFramesRef = useRef(totalFrames);
  fpsRef.current = fps;
  totalFramesRef.current = totalFrames;

  // Push speed/loop into every <video>.
  useEffect(() => {
    const map = videoRefs.current;
    if (!map) return;
    for (const v of map.values()) {
      v.playbackRate = speed;
      v.loop = loop;
    }
  }, [speed, loop, videoRefs]);

  // 60fps cursor: while playing, sample the first video's currentTime so
  // graph cursors move smoothly between onTimeUpdate ticks.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const map = videoRefs.current;
      const first = map?.values().next().value;
      if (first) {
        const t = first.currentTime;
        let f = t * fpsRef.current;
        const max = Math.max(0, totalFramesRef.current - 1);
        if (f >= max) {
          if (loop) {
            f = 0;
            if (map) for (const v of map.values()) v.currentTime = 0;
          } else {
            f = max;
            setIsPlaying(false);
          }
        }
        setFrame(f);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, loop, videoRefs]);

  const seek = useCallback(
    (target: number) => {
      const max = Math.max(0, totalFramesRef.current - 1);
      const clamped = Math.min(max, Math.max(0, target));
      setFrame(clamped);
      const time = clamped / Math.max(1, fpsRef.current);
      const map = videoRefs.current;
      if (!map) return;
      for (const v of map.values()) v.currentTime = time;
    },
    [videoRefs],
  );

  return { frame, isPlaying, speed, loop, setIsPlaying, setSpeed, setLoop, seek };
}
