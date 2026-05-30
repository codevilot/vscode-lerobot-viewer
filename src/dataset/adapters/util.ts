// Helpers shared between dataset adapters. Kept dependency-free so they
// remain trivially testable.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FeatureSpec, LeRobotInfo } from "../../types";

export async function readJson(file: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

export async function readJsonlIfExists(file: string): Promise<Record<string, unknown>[] | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Skip malformed lines silently — caller already logs file path.
    }
  }
  return out;
}

/**
 * Serialize an array of records to newline-delimited JSON. A trailing
 * newline is appended so the file is a valid text file.
 */
export async function writeJsonl(file: string, records: Record<string, unknown>[]): Promise<void> {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(file, lines, "utf8");
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function normalizeInfo(raw: Record<string, unknown>): LeRobotInfo {
  const featuresRaw = (raw.features ?? {}) as Record<string, unknown>;
  const features: Record<string, FeatureSpec> = {};
  for (const [key, value] of Object.entries(featuresRaw)) {
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      // v3.0 datasets nest codec/fps under `video_info`; v2.x sometimes
      // uses `info`. Accept either so downstream code only sees one shape.
      const extra =
        (v.video_info as Record<string, unknown> | undefined) ??
        (v.info as Record<string, unknown> | undefined);
      features[key] = {
        dtype: String(v.dtype ?? "unknown"),
        shape: Array.isArray(v.shape) ? (v.shape as number[]) : undefined,
        names: v.names as FeatureSpec["names"],
        info: extra,
      };
    }
  }
  return {
    codebaseVersion: optionalString(raw.codebase_version),
    robotType: optionalString(raw.robot_type),
    fps: Number(raw.fps ?? 30),
    totalEpisodes: Number(raw.total_episodes ?? 0),
    totalFrames: Number(raw.total_frames ?? 0),
    totalTasks: optionalNumber(raw.total_tasks),
    totalVideos: optionalNumber(raw.total_videos),
    totalChunks: optionalNumber(raw.total_chunks),
    chunksSize: optionalNumber(raw.chunks_size),
    dataFilesSizeInMb: optionalNumber(raw.data_files_size_in_mb),
    videoFilesSizeInMb: optionalNumber(raw.video_files_size_in_mb),
    splits: (raw.splits as Record<string, string>) ?? undefined,
    dataPath: optionalString(raw.data_path),
    videoPath: optionalString(raw.video_path),
    features,
    raw,
  };
}

/**
 * Minimal substitute for Python format specifiers used by LeRobot path
 * templates: `{episode_index:06d}` → zero-padded integer.
 */
export function expandTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)(?::(\d+)d)?\}/g, (_match, name: string, padding?: string) => {
    const value = vars[name];
    if (value === undefined) return "";
    if (padding && typeof value === "number") {
      return String(value).padStart(Number(padding), "0");
    }
    return String(value);
  });
}

export interface FeatureClassification {
  cameraKeys: string[];
  stateKeys: string[];
  actionKeys: string[];
  velocityKeys: string[];
  effortKeys: string[];
  environmentStateKeys: string[];
  /** Single-column scalar/event feature names if present in the dataset. */
  rewardKey?: string;
  doneKey?: string;
  successKey?: string;
  truncatedKey?: string;
  taskIndexKey?: string;
}

export function classifyFeatures(features: Record<string, FeatureSpec>): FeatureClassification {
  const cameraKeys: string[] = [];
  const stateKeys: string[] = [];
  const actionKeys: string[] = [];
  const velocityKeys: string[] = [];
  const effortKeys: string[] = [];
  const environmentStateKeys: string[] = [];
  let rewardKey: string | undefined;
  let doneKey: string | undefined;
  let successKey: string | undefined;
  let truncatedKey: string | undefined;
  let taskIndexKey: string | undefined;
  for (const [key, feat] of Object.entries(features)) {
    if (feat.dtype === "video" || key.startsWith("observation.images.")) {
      cameraKeys.push(key);
    } else if (key === "observation.state" || key.startsWith("observation.state.")) {
      stateKeys.push(key);
    } else if (key === "observation.velocity" || key.startsWith("observation.velocity.")) {
      velocityKeys.push(key);
    } else if (key === "observation.effort" || key.startsWith("observation.effort.")) {
      effortKeys.push(key);
    } else if (
      key === "observation.environment_state" ||
      key.startsWith("observation.environment_state.")
    ) {
      environmentStateKeys.push(key);
    } else if (key === "action" || key.startsWith("action.")) {
      actionKeys.push(key);
    } else if (key === "next.reward" || key === "reward") {
      rewardKey = key;
    } else if (key === "next.done") {
      doneKey = key;
    } else if (key === "next.success") {
      successKey = key;
    } else if (key === "next.truncated") {
      truncatedKey = key;
    } else if (key === "task_index") {
      taskIndexKey = key;
    }
  }
  return {
    cameraKeys,
    stateKeys,
    actionKeys,
    velocityKeys,
    effortKeys,
    environmentStateKeys,
    rewardKey,
    doneKey,
    successKey,
    truncatedKey,
    taskIndexKey,
  };
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string") as string[];
  if (typeof value === "string") return [value];
  return [];
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function joinPath(...parts: string[]): string {
  return path.join(...parts);
}

/**
 * Build the dataset-relative path for an episode's data parquet using
 * the dataset's `data_path` template. Used by both adapters and by the
 * SSH pre-fetch path; centralized here so the placeholder vocabulary
 * (`chunk_index`, `episode_chunk`, `file_index`, `episode_index`) stays
 * in one place.
 */
export function buildDataPath(args: {
  template: string;
  chunkIndex: number;
  fileIndex: number;
  episodeIndex: number;
}): string {
  return expandTemplate(args.template, {
    chunk_index: args.chunkIndex,
    episode_chunk: args.chunkIndex,
    file_index: args.fileIndex,
    episode_index: args.episodeIndex,
  });
}

export function buildVideoPath(args: {
  template: string;
  chunkIndex: number;
  fileIndex: number;
  episodeIndex: number;
  videoKey: string;
}): string {
  return expandTemplate(args.template, {
    chunk_index: args.chunkIndex,
    episode_chunk: args.chunkIndex,
    file_index: args.fileIndex,
    episode_index: args.episodeIndex,
    video_key: args.videoKey,
  });
}

/**
 * Best-effort episode list when no episodes metadata is available — uses
 * info totals to fabricate a uniform-length episode array. Both v2.x and
 * v3.0 adapters fall back to this when their canonical metadata is absent.
 */
export function synthesizeEpisodes(
  totalEpisodes: number,
  totalFrames: number,
): Array<{ episodeIndex: number; tasks: string[]; length: number }> {
  if (!totalEpisodes) return [];
  const perEpisode = totalEpisodes > 0 ? Math.max(1, Math.round(totalFrames / totalEpisodes)) : 0;
  return Array.from({ length: totalEpisodes }, (_, i) => ({
    episodeIndex: i,
    tasks: [],
    length: perEpisode,
  }));
}
