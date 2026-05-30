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
  shardFrameOffset?: number,
): PlaybackController {
  const [frame, setFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);

  // Refs avoid re-binding the rAF loop on every render.
  const fpsRef = useRef(fps);
  const totalFramesRef = useRef(totalFrames);
  const shardOffsetRef = useRef(shardFrameOffset ?? 0);
  fpsRef.current = fps;
  totalFramesRef.current = totalFrames;
  shardOffsetRef.current = shardFrameOffset ?? 0;

  // Initialize video currentTime when shard offset changes (v3.0 sharded layouts).
  // This ensures videos start at the correct position within the shard.
  useEffect(() => {
    const map = videoRefs.current;
    if (!map || shardFrameOffset === undefined) return;
    const initialTime = shardFrameOffset / Math.max(1, fpsRef.current);
    for (const v of map.values()) {
      if (!isNaN(initialTime) && isFinite(initialTime)) {
        v.currentTime = initialTime;
      }
    }
    // Also reset frame display to 0 when shard offset changes
    setFrame(0);
  }, [shardFrameOffset, videoRefs]);

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
        let f = t * fpsRef.current - shardOffsetRef.current;
        const max = Math.max(0, totalFramesRef.current - 1);
        if (f >= max) {
          if (loop) {
            f = 0;
            const resetTime = shardOffsetRef.current / Math.max(1, fpsRef.current);
            if (map) for (const v of map.values()) v.currentTime = resetTime;
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
      const time = (shardOffsetRef.current + clamped) / Math.max(1, fpsRef.current);
      const map = videoRefs.current;
      if (!map) return;
      for (const v of map.values()) v.currentTime = time;
    },
    [videoRefs],
  );

  return { frame, isPlaying, speed, loop, setIsPlaying, setSpeed, setLoop, seek };
}
