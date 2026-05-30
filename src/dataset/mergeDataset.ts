// Dataset merge — combines multiple v2.x LeRobot datasets into a single new
// dataset directory. Files are physically copied (not linked) so the result
// is self-contained and portable.
//
// Supported: v2.0 / v2.1 → v2.1
// Not yet supported: v3.0, SSH datasets

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatasetSnapshot, LeRobotEpisode, TaskInfo } from "../types";
import {
  buildDataPath,
  buildVideoPath,
  exists,
  writeJsonl,
} from "./adapters/util";

// ---- public API ----

export interface MergeProgress {
  /** Episodes processed so far. */
  done: number;
  /** Total episodes across all sources. */
  total: number;
  /** Human-readable description of what is happening right now. */
  current: string;
}

export interface MergeResult {
  totalEpisodes: number;
  totalFrames: number;
  totalTasks: number;
}

/**
 * Merge one or more v2.x dataset snapshots into `targetRoot`. The target
 * directory is created if it doesn't exist.
 *
 * Throws when sources are incompatible (different fps, incompatible action /
 * state shapes, mixed versions).
 */
export async function mergeDatasets(
  snapshots: DatasetSnapshot[],
  targetRoot: string,
  onProgress: (p: MergeProgress) => void,
): Promise<MergeResult> {
  if (snapshots.length < 2) {
    throw new Error("At least 2 datasets are required to merge.");
  }

  // ---- validate compatibility ----
  validateCompatibility(snapshots);

  const chunksSize = snapshots[0].info.chunksSize ?? 1000;
  const fps = snapshots[0].info.fps;
  const allCameraKeys = unionCameraKeys(snapshots);
  const mergedTasks = mergeTasks(snapshots);
  const mergedEpisodes = reindexEpisodes(snapshots);
  const totalFrames = mergedEpisodes.reduce((sum, e) => sum + e.length, 0);

  // ---- prepare target ----
  await fs.mkdir(path.join(targetRoot, "meta"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "videos"), { recursive: true });

  // ---- copy parquet + video files ----
  const total = mergedEpisodes.length;
  let done = 0;

  for (const ep of mergedEpisodes) {
    const srcSnapshot = ep._srcSnapshot!;
    const srcEp = ep._srcEpisode!;

    // ---- data parquet ----
    const srcDataPath = resolveSourceDataPath(srcSnapshot, srcEp);
    if (srcDataPath && (await exists(srcDataPath))) {
      const dstDataRel = buildDataPath({
        template: "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        chunkIndex: Math.floor(ep.episodeIndex / chunksSize),
        fileIndex: 0,
        episodeIndex: ep.episodeIndex,
      });
      const dstDataPath = path.join(targetRoot, dstDataRel);
      onProgress({ done, total, current: `Copying parquet for episode ${ep.episodeIndex}` });
      await fs.mkdir(path.dirname(dstDataPath), { recursive: true });
      await fs.cp(srcDataPath, dstDataPath);
    }

    // ---- video files ----
    for (const camKey of allCameraKeys) {
      const srcVideo = await resolveSourceVideo(srcSnapshot, srcEp, camKey);
      if (srcVideo) {
        const dstVideoRel = buildVideoPath({
          template: "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
          chunkIndex: Math.floor(ep.episodeIndex / chunksSize),
          fileIndex: 0,
          episodeIndex: ep.episodeIndex,
          videoKey: camKey,
        });
        const dstVideoPath = path.join(targetRoot, dstVideoRel);
        onProgress({ done, total, current: `Copying video ${camKey} for episode ${ep.episodeIndex}` });
        await fs.mkdir(path.dirname(dstVideoPath), { recursive: true });
        await fs.cp(srcVideo, dstVideoPath);
      }
    }

    done++;
    onProgress({ done, total, current: `Episode ${ep.episodeIndex} complete` });
  }

  // ---- write info.json ----
  const firstInfo = snapshots[0].info;
  const info: Record<string, unknown> = {
    ...firstInfo.raw,
    codebase_version: firstInfo.codebaseVersion ?? "v2.1",
    fps,
    total_episodes: total,
    total_frames: totalFrames,
    total_tasks: mergedTasks.length,
    total_videos: total * allCameraKeys.length,
    chunks_size: chunksSize,
    data_path: "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
    video_path: "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
    features: buildMergedFeatures(snapshots, allCameraKeys),
  };
  await fs.writeFile(
    path.join(targetRoot, "meta", "info.json"),
    JSON.stringify(info, null, 2),
    "utf8",
  );

  // ---- write episodes.jsonl ----
  const epRecords = mergedEpisodes.map((ep) => ({
    episode_index: ep.episodeIndex,
    tasks: ep.tasks,
    length: ep.length,
  }));
  await writeJsonl(path.join(targetRoot, "meta", "episodes.jsonl"), epRecords);

  // ---- write tasks.jsonl ----
  const taskRecords = mergedTasks.map((t) => ({
    task_index: t.taskIndex,
    task: t.task,
  }));
  await writeJsonl(path.join(targetRoot, "meta", "tasks.jsonl"), taskRecords);

  return { totalEpisodes: total, totalFrames, totalTasks: mergedTasks.length };
}

// ---- validation ----

function validateCompatibility(snapshots: DatasetSnapshot[]): void {
  const base = snapshots[0];
  if (base.version !== "v2.0" && base.version !== "v2.1") {
    throw new Error("Only v2.0 / v2.1 datasets can be merged.");
  }

  const baseStateShape = JSON.stringify(base.info.features["observation.state"]?.shape);
  const baseActionShape = JSON.stringify(base.info.features["action"]?.shape);

  for (let i = 1; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s.version !== "v2.0" && s.version !== "v2.1") {
      throw new Error(
        `Dataset "${s.descriptor.name}" is ${s.version}; only v2.x datasets can be merged.`,
      );
    }
    if (s.info.fps !== base.info.fps) {
      throw new Error(
        `FPS mismatch: "${base.descriptor.name}" is ${base.info.fps}fps but ` +
          `"${s.descriptor.name}" is ${s.info.fps}fps.`,
      );
    }
    const sStateShape = JSON.stringify(s.info.features["observation.state"]?.shape);
    if (sStateShape !== baseStateShape) {
      throw new Error(
        `State shape mismatch between "${base.descriptor.name}" and "${s.descriptor.name}".`,
      );
    }
    const sActionShape = JSON.stringify(s.info.features["action"]?.shape);
    if (sActionShape !== baseActionShape) {
      throw new Error(
        `Action shape mismatch between "${base.descriptor.name}" and "${s.descriptor.name}".`,
      );
    }
  }
}

// ---- episode re-indexing ----

interface MergeEpisode extends LeRobotEpisode {
  _srcSnapshot: DatasetSnapshot;
  _srcEpisode: LeRobotEpisode;
}

function reindexEpisodes(snapshots: DatasetSnapshot[]): MergeEpisode[] {
  const out: MergeEpisode[] = [];
  let nextIndex = 0;
  for (const snap of snapshots) {
    const sorted = [...snap.episodes].sort((a, b) => a.episodeIndex - b.episodeIndex);
    for (const ep of sorted) {
      out.push({
        episodeIndex: nextIndex++,
        tasks: ep.tasks,
        length: ep.length,
        _srcSnapshot: snap,
        _srcEpisode: ep,
      });
    }
  }
  return out;
}

// ---- task merging ----

function mergeTasks(snapshots: DatasetSnapshot[]): TaskInfo[] {
  const seen = new Map<string, number>(); // task name → assigned task_index
  let nextIdx = 0;
  for (const snap of snapshots) {
    for (const t of snap.tasks) {
      if (!seen.has(t.task)) {
        seen.set(t.task, nextIdx++);
      }
    }
  }
  return [...seen.entries()].map(([task, taskIndex]) => ({ taskIndex, task }));
}

// ---- camera keys ----

function unionCameraKeys(snapshots: DatasetSnapshot[]): string[] {
  const keys = new Set<string>();
  for (const s of snapshots) {
    for (const k of s.cameraKeys) keys.add(k);
  }
  return [...keys].sort();
}

// ---- feature merging ----

function buildMergedFeatures(
  snapshots: DatasetSnapshot[],
  _cameraKeys: string[],
): Record<string, unknown> {
  // Take features from the first snapshot and augment with any extra cameras.
  const features = { ...snapshots[0].info.features } as Record<string, unknown>;
  for (const snap of snapshots) {
    for (const camKey of snap.cameraKeys) {
      if (!(camKey in features)) {
        features[camKey] = snap.info.features[camKey];
      }
    }
  }
  return features;
}

// ---- path resolution for source files ----

function resolveSourceDataPath(
  snapshot: DatasetSnapshot,
  episode: LeRobotEpisode,
): string | undefined {
  const root = snapshot.descriptor.root;
  if (!root) return undefined;
  const chunksSize = snapshot.info.chunksSize ?? 1000;
  const rel = buildDataPath({
    template: snapshot.info.dataPath ?? "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
    chunkIndex: Math.floor(episode.episodeIndex / chunksSize),
    fileIndex: 0,
    episodeIndex: episode.episodeIndex,
  });
  return path.join(root, rel);
}

async function resolveSourceVideo(
  snapshot: DatasetSnapshot,
  episode: LeRobotEpisode,
  videoKey: string,
): Promise<string | undefined> {
  const root = snapshot.descriptor.root;
  if (!root) return undefined;
  const chunksSize = snapshot.info.chunksSize ?? 1000;
  const rel = buildVideoPath({
    template:
      snapshot.info.videoPath ??
      "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
    chunkIndex: Math.floor(episode.episodeIndex / chunksSize),
    fileIndex: 0,
    episodeIndex: episode.episodeIndex,
    videoKey,
  });
  const abs = path.join(root, rel);
  return (await exists(abs)) ? abs : undefined;
}
