// LeRobot v2.0 / v2.1 adapter.
//
// Layout assumptions (driven by the templates declared in info.json):
//   data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet
//   videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4
//
// Episodes come from `meta/episodes.jsonl` — one JSON object per line. We
// never enumerate `data/**/*.parquet` to derive the list, because that
// hides missing/extra episodes and won't generalize to v3.0 shards.

import * as path from "node:path";
import type { LeRobotEpisode, LeRobotInfo, TaskInfo } from "../../types";
import type { AdapterContext, DatasetAdapter, VideoLocation } from "./types";
import {
  buildDataPath,
  buildVideoPath,
  classifyFeatures,
  exists,
  joinPath,
  normalizeInfo,
  readJson,
  readJsonlIfExists,
  synthesizeEpisodes,
  toStringArray,
} from "./util";

const DEFAULT_DATA_TEMPLATE = "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
const DEFAULT_VIDEO_TEMPLATE = "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";

export class V21Adapter implements DatasetAdapter {
  constructor(public readonly version: "v2.0" | "v2.1" = "v2.1") {}

  async loadInfo(root: string): Promise<LeRobotInfo> {
    return normalizeInfo(await readJson(path.join(root, "meta", "info.json")));
  }

  async loadEpisodes(ctx: AdapterContext): Promise<LeRobotEpisode[]> {
    const records = await readJsonlIfExists(path.join(ctx.root, "meta", "episodes.jsonl"));
    if (records && records.length > 0) {
      const out: LeRobotEpisode[] = records.map((obj, i) => ({
        episodeIndex: Number(obj.episode_index ?? i),
        tasks: toStringArray(obj.tasks),
        length: Number(obj.length ?? 0),
      }));
      out.sort((a, b) => a.episodeIndex - b.episodeIndex);
      return out;
    }
    // Best-effort fallback when episodes.jsonl is missing: synthesize from
    // info totals so the UI still renders an episode list.
    return synthesizeEpisodes(ctx.info.totalEpisodes, ctx.info.totalFrames);
  }

  async resolveVideo(
    ctx: AdapterContext,
    episode: LeRobotEpisode,
    videoKey: string,
  ): Promise<VideoLocation | undefined> {
    const chunkSize = ctx.info.chunksSize ?? 1000;
    const filled = buildVideoPath({
      template: ctx.info.videoPath ?? DEFAULT_VIDEO_TEMPLATE,
      chunkIndex: Math.floor(episode.episodeIndex / chunkSize),
      fileIndex: 0,
      episodeIndex: episode.episodeIndex,
      videoKey,
    });
    const abs = joinPath(ctx.root, filled);
    return (await exists(abs)) ? { path: abs } : undefined;
  }

  async loadTasks(ctx: AdapterContext): Promise<TaskInfo[]> {
    // v2.x ships tasks in meta/tasks.jsonl; we also accept a JSON array
    // dropped by older converters.
    const jsonl = await readJsonlIfExists(path.join(ctx.root, "meta", "tasks.jsonl"));
    if (jsonl && jsonl.length > 0) {
      return jsonl
        .map((row, i): TaskInfo => ({
          taskIndex: typeof row.task_index === "number" ? row.task_index : i,
          task: typeof row.task === "string" ? row.task : "",
        }))
        .filter((t) => t.task.length > 0);
    }
    return [];
  }

  async resolveDataFile(
    ctx: AdapterContext,
    episode: LeRobotEpisode,
  ): Promise<string | undefined> {
    const chunkSize = ctx.info.chunksSize ?? 1000;
    const filled = buildDataPath({
      template: ctx.info.dataPath ?? DEFAULT_DATA_TEMPLATE,
      chunkIndex: Math.floor(episode.episodeIndex / chunkSize),
      fileIndex: 0,
      episodeIndex: episode.episodeIndex,
    });
    const abs = joinPath(ctx.root, filled);
    return (await exists(abs)) ? abs : undefined;
  }
}

export { classifyFeatures };
