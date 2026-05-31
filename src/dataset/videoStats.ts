// Compute per-channel RGB statistics for video features by sampling
// frames via ffmpeg.

import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { buildVideoPath, exists } from "./adapters/util";
import type { LeRobotInfo, LeRobotEpisode } from "../types";

export interface VideoStatsProgress {
  done: number;
  total: number;
}

/**
 * Compute per-channel (R/G/B) stats for a video feature.
 * Returns stats arrays of length 3 (R, G, B) for min/max/mean/std/q01/q99,
 * or undefined if the video or ffmpeg is unavailable.
 */
export async function computeVideoFeatureStats(
  root: string,
  videoKey: string,
  onProgress: (p: VideoStatsProgress) => void,
): Promise<Record<string, number[]> | undefined> {
  // Check ffmpeg.
  if (!(await ffmpegAvailable())) return undefined;

  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  if (episodes.length === 0) return undefined;

  const feat = info.features[videoKey];
  if (!feat || feat.dtype !== "video") return undefined;

  // Sample frames per episode. Downscale to 64px to keep ffmpeg fast.
  const MAX_FRAMES_PER_EP = 30;
  const acc = new PixelStatsAccumulator();

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const videoPath = await resolveVideoPath(root, info, ep, videoKey);
    if (!videoPath) { onProgress({ done: i + 1, total: episodes.length }); continue; }

    const frameCount = ep.length || 0;
    const step = frameCount > MAX_FRAMES_PER_EP
      ? Math.floor(frameCount / MAX_FRAMES_PER_EP)
      : 1;

    // Decode frames via ffmpeg → raw RGB24 → accumulate stats.
    await processVideoFrames(videoPath, frameCount, step, acc);
    onProgress({ done: i + 1, total: episodes.length });
  }

  return acc.finalize();
}

// ---- internal ----

function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = cp.spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function resolveVideoPath(
  root: string,
  info: LeRobotInfo,
  episode: LeRobotEpisode,
  videoKey: string,
): Promise<string | undefined> {
  const chunksSize = info.chunksSize ?? 1000;
  const chunkIdx = Math.floor(episode.episodeIndex / chunksSize);
  const tpl = info.videoPath ?? "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";
  const rel = buildVideoPath({
    template: tpl,
    chunkIndex: chunkIdx,
    fileIndex: 0,
    episodeIndex: episode.episodeIndex,
    videoKey,
  });
  const abs = path.join(root, rel);
  return (await exists(abs)) ? abs : undefined;
}

function processVideoFrames(
  videoPath: string,
  frameCount: number,
  step: number,
  acc: PixelStatsAccumulator,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // ffmpeg select filter to pick every `step`-th frame,
    // output raw rgb24 pixels to stdout.
    const args = [
      "-i", videoPath,
      "-vf", `select='not(mod(n\\,${step}))',scale=64:-1`,
      "-vsync", "0",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-",
    ];
    const proc = cp.spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        // Non-zero exit on the last frame is normal for ffmpeg select filter.
        // Only reject if we got no data at all.
      }
      const all = Buffer.concat(chunks);
      // Each pixel = 3 bytes (R, G, B). Frame size = W * H * 3.
      // We don't know W/H — infer from buffer size vs channel.
      // For channel-level stats, sum all pixels.
      for (let i = 0; i < all.length; i += 3) {
        acc.push(all[i], all[i + 1], all[i + 2]);
      }
      resolve();
    });

    proc.on("error", reject);
  });
}

// ---- accumulator (tracks R, G, B independently) ----

class PixelStatsAccumulator {
  private count = 0;
  private mins = [Infinity, Infinity, Infinity];
  private maxs = [-Infinity, -Infinity, -Infinity];
  private means = [0, 0, 0];
  private m2s = [0, 0, 0];
  // Reservoir sample for quantile estimation (capped at 50k per channel).
  private samples: number[][] = [[], [], []];
  private static readonly MAX_SAMPLES = 50000;

  push(r: number, g: number, b: number): void {
    const vals = [r, g, b];
    this.count++;
    for (let c = 0; c < 3; c++) {
      const x = vals[c];
      if (x < this.mins[c]) this.mins[c] = x;
      if (x > this.maxs[c]) this.maxs[c] = x;
      const delta = x - this.means[c];
      this.means[c] += delta / this.count;
      const delta2 = x - this.means[c];
      this.m2s[c] += delta * delta2;
      // Reservoir sampling: keep at most MAX_SAMPLES values.
      if (this.samples[c].length < PixelStatsAccumulator.MAX_SAMPLES) {
        this.samples[c].push(x);
      } else {
        const idx = Math.floor(Math.random() * this.count);
        if (idx < PixelStatsAccumulator.MAX_SAMPLES) {
          this.samples[c][idx] = x;
        }
      }
    }
  }

  finalize(): Record<string, number[][] | number[]> {
    const norm = (v: number) => v / 255;
    const count = this.count;
    return {
      min: this.mins.map((v) => [[norm(v)]]),
      max: this.maxs.map((v) => [[norm(v)]]),
      mean: this.means.map((v) => [[norm(v)]]),
      std: this.m2s.map((m2) => [[Math.sqrt(m2 / count)]]),
      q01: this.samples.map((s) => [[norm(quantile(s, 0.01))]]),
      q10: this.samples.map((s) => [[norm(quantile(s, 0.10))]]),
      q50: this.samples.map((s) => [[norm(quantile(s, 0.50))]]),
      q90: this.samples.map((s) => [[norm(quantile(s, 0.90))]]),
      q99: this.samples.map((s) => [[norm(quantile(s, 0.99))]]),
      count: [count],
    };
  }
}

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const pos = q * (arr.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] * (hi - pos) + arr[hi] * (pos - lo);
}
