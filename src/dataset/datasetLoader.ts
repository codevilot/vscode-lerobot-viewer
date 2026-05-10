// Facade over the adapter layer. The rest of the extension only depends
// on this module — it does not import adapters directly. That way the
// version-dispatch policy lives in one place.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { log, logError } from "../log";
import type {
  DatasetDescriptor,
  DatasetSnapshot,
  FeatureStats,
  LeRobotEpisode,
  LeRobotInfo,
  TaskInfo,
} from "../types";
import { detectDatasetVersion } from "./DatasetVersionDetector";
import { getAdapter } from "./adapters";
import type { DatasetAdapter, VideoLocation } from "./adapters";
import { buildDataPath, buildVideoPath, classifyFeatures, exists } from "./adapters/util";
import { ensureSshFile } from "./ssh";

export async function isLeRobotDataset(root: string): Promise<boolean> {
  return exists(path.join(root, "meta", "info.json"));
}

export async function loadDataset(descriptor: DatasetDescriptor): Promise<DatasetSnapshot> {
  if (!descriptor.root) {
    throw new Error(
      `Dataset ${descriptor.name} has no local root; remote-only loading is not yet implemented.`,
    );
  }
  const detection = await detectDatasetVersion(descriptor.root);
  log(`Dataset version for ${descriptor.name}: ${detection.version} (${detection.reason})`);

  const adapter = getAdapter(detection.version);
  const info = await adapter.loadInfo(descriptor.root);
  const ctx = { root: descriptor.root, info };
  const [episodes, rawTasks, stats] = await Promise.all([
    adapter.loadEpisodes(ctx),
    adapter.loadTasks(ctx),
    loadStats(descriptor.root),
  ]);
  const adapterWarnings = collectAdapterWarnings(adapter);
  const classification = classifyFeatures(info.features);
  const tasks = annotateTaskCounts(rawTasks, episodes);
  const splits = parseSplits(info.splits);

  return {
    descriptor,
    info,
    episodes,
    cameraKeys: classification.cameraKeys,
    stateKeys: classification.stateKeys,
    actionKeys: classification.actionKeys,
    velocityKeys: classification.velocityKeys,
    effortKeys: classification.effortKeys,
    environmentStateKeys: classification.environmentStateKeys,
    rewardKey: classification.rewardKey,
    doneKey: classification.doneKey,
    successKey: classification.successKey,
    truncatedKey: classification.truncatedKey,
    taskIndexKey: classification.taskIndexKey,
    tasks,
    stats,
    splits,
    version: detection.version,
    warnings: [...detection.warnings, ...adapterWarnings],
  };
}

/**
 * Read meta/stats.json (LeRobot's dataset-wide normalization stats). Supports
 * the canonical layout where each feature maps to {min,max,mean,std,q01,q99}
 * arrays. Missing/malformed fields are simply skipped — never throw.
 */
async function loadStats(root: string): Promise<Record<string, FeatureStats>> {
  const file = path.join(root, "meta", "stats.json");
  if (!(await exists(file))) return {};
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const out: Record<string, FeatureStats> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      out[key] = {
        min: toNumberArray(v.min),
        max: toNumberArray(v.max),
        mean: toNumberArray(v.mean),
        std: toNumberArray(v.std),
        q01: toNumberArray(v.q01),
        q99: toNumberArray(v.q99),
        count: typeof v.count === "number" ? v.count : undefined,
      };
    }
    return out;
  } catch (err) {
    logError(`reading stats.json from ${root}`, err);
    return {};
  }
}

function toNumberArray(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    const flat: number[] = [];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (typeof v === "number") flat.push(v);
    };
    visit(value);
    return flat.length > 0 ? flat : undefined;
  }
  if (typeof value === "number") return [value];
  return undefined;
}

/**
 * Parse info.splits values like {"train": "0:200", "val": "200:250"} into a
 * Record<string, [from, to]> for easier consumption.
 */
function parseSplits(raw?: Record<string, string>): Record<string, [number, number]> {
  if (!raw) return {};
  const out: Record<string, [number, number]> = {};
  for (const [name, range] of Object.entries(raw)) {
    const m = /^(\d+):(\d+)$/.exec(range.trim());
    if (m) out[name] = [Number(m[1]), Number(m[2])];
  }
  return out;
}

function annotateTaskCounts(tasks: TaskInfo[], episodes: LeRobotEpisode[]): TaskInfo[] {
  if (tasks.length === 0 && episodes.length === 0) return [];
  const counts = new Map<string, number>();
  for (const ep of episodes) {
    for (const t of ep.tasks) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // If we have a declared task list, preserve its ordering and fill in counts.
  if (tasks.length > 0) {
    return tasks.map((t) => ({ ...t, episodeCount: counts.get(t.task) ?? 0 }));
  }
  // Otherwise, derive distinct tasks from episode entries.
  const out: TaskInfo[] = [];
  let i = 0;
  for (const [task, episodeCount] of counts) {
    out.push({ taskIndex: i++, task, episodeCount });
  }
  return out;
}

export async function resolveVideoUri(
  snapshot: DatasetSnapshot,
  episode: LeRobotEpisode,
  videoKey: string,
): Promise<{ uri: vscode.Uri; location: VideoLocation } | undefined> {
  if (!snapshot.descriptor.root) return undefined;
  // For SSH datasets, materialize the file before resolving so the adapter's
  // existence check passes against the local cache mirror.
  if (snapshot.descriptor.source === "ssh") {
    const relPath = predictVideoRelative(snapshot, episode, videoKey);
    if (relPath) {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: `LeRobot · ${path.basename(relPath)}`,
          },
          async (progress) => {
            await ensureSshFile(snapshot.descriptor, relPath, (msg) =>
              progress.report({ message: msg }),
            );
          },
        );
      } catch (err) {
        log(`SSH video fetch failed for ${relPath}: ${(err as Error).message}`);
      }
    }
  }
  const adapter = getAdapter(snapshot.version);
  const location = await adapter.resolveVideo(
    { root: snapshot.descriptor.root, info: snapshot.info },
    episode,
    videoKey,
  );
  if (!location) return undefined;
  return { uri: vscode.Uri.file(location.path), location };
}

/**
 * Compute the dataset-relative POSIX path for a video without any I/O.
 * Mirrors the template logic inside the adapters so SSH pre-fetch can
 * run before the adapter's existence check.
 */
function predictVideoRelative(
  snapshot: DatasetSnapshot,
  episode: LeRobotEpisode,
  videoKey: string,
): string {
  const videoShard = episode.videoShards?.[videoKey];
  const dataShard = episode.dataShard;
  const chunkSize = snapshot.info.chunksSize ?? 1000;
  return buildVideoPath({
    template: snapshot.info.videoPath ?? defaultVideoTemplate(snapshot.version),
    chunkIndex:
      videoShard?.chunkIndex ?? dataShard?.chunkIndex ?? Math.floor(episode.episodeIndex / chunkSize),
    fileIndex: videoShard?.fileIndex ?? dataShard?.fileIndex ?? 0,
    episodeIndex: episode.episodeIndex,
    videoKey,
  });
}

/**
 * Compute the dataset-relative POSIX path for an episode's data parquet
 * file. Used by parquetReader to pre-fetch from SSH.
 */
export function predictDataRelative(
  snapshot: DatasetSnapshot,
  episode: LeRobotEpisode,
): string {
  const chunkSize = snapshot.info.chunksSize ?? 1000;
  return buildDataPath({
    template: snapshot.info.dataPath ?? defaultDataTemplate(snapshot.version),
    chunkIndex: episode.dataShard?.chunkIndex ?? Math.floor(episode.episodeIndex / chunkSize),
    fileIndex: episode.dataShard?.fileIndex ?? 0,
    episodeIndex: episode.episodeIndex,
  });
}

function defaultVideoTemplate(version: DatasetSnapshot["version"]): string {
  return version === "v3.0"
    ? "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4"
    : "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";
}

function defaultDataTemplate(version: DatasetSnapshot["version"]): string {
  return version === "v3.0"
    ? "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
    : "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
}

export type { LeRobotInfo, LeRobotEpisode };

function collectAdapterWarnings(adapter: DatasetAdapter): string[] {
  // Adapters expose an optional `warnings` array (V30Adapter populates it
  // during loadEpisodes). Read defensively to avoid coupling.
  const candidate = (adapter as unknown as { warnings?: unknown }).warnings;
  return Array.isArray(candidate) ? candidate.filter((w) => typeof w === "string") : [];
}
