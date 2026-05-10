// LeRobot v3.0 adapter.
//
// In v3.0, multiple episodes share a single parquet/video shard. The
// authoritative episode → shard mapping lives in
// `meta/episodes/chunk-XXX/file-YYY.parquet` boundary files.
//
// Schema of those parquet files (per recent LeRobot main):
//   episode_index            int64
//   data/chunk_index         int64
//   data/file_index          int64
//   dataset_from_index       int64
//   dataset_to_index         int64
//   videos/<key>/chunk_index int64       (one set of columns per camera)
//   videos/<key>/file_index  int64
//   videos/<key>/from_timestamp double
//   videos/<key>/to_timestamp   double
//   tasks                    list<string>
//   length                   int64
//   stats/...                various aggregate columns we ignore
//
// We use hyparquet (pure JS) to decode just the structural columns. If the
// parquet files cannot be read for any reason we fall back to two earlier
// best-effort paths so loading never aborts entirely:
//   1. transitional `meta/episodes.jsonl`
//   2. `meta/episodes/episodes_metadata.json`
//   3. directory scan + warning

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LeRobotEpisode, LeRobotInfo, ShardLocation, TaskInfo } from "../../types";

// hyparquet is ESM-only; lazy-load via dynamic import so this module stays
// loadable from a CJS context (tsx test runner, VS Code extension host).
let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() {
  return (hyparquetPromise ??= import("hyparquet"));
}
import type { AdapterContext, DatasetAdapter, VideoLocation } from "./types";
import {
  buildVideoPath,
  exists,
  joinPath,
  normalizeInfo,
  readJson,
  readJsonlIfExists,
  synthesizeEpisodes,
  toStringArray,
} from "./util";

const DEFAULT_VIDEO_TEMPLATE_V3 =
  "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4";

export class V30Adapter implements DatasetAdapter {
  readonly version = "v3.0" as const;

  /** Warnings collected during the most recent loadEpisodes call. */
  warnings: string[] = [];

  async loadInfo(root: string): Promise<LeRobotInfo> {
    return normalizeInfo(await readJson(path.join(root, "meta", "info.json")));
  }

  async loadEpisodes(ctx: AdapterContext): Promise<LeRobotEpisode[]> {
    this.warnings = [];

    // 1. Authoritative path: meta/episodes/**/*.parquet
    const shardFiles = await listEpisodeShardFiles(ctx.root);
    if (shardFiles.length > 0) {
      try {
        const out = await readEpisodesFromParquet(shardFiles);
        if (out.length > 0) return out;
        this.warnings.push("meta/episodes parquet contained no rows; falling back to other sources.");
      } catch (err) {
        this.warnings.push(
          `Failed to decode meta/episodes parquet (${(err as Error).message}); falling back.`,
        );
      }
    }

    // 2. Transitional jsonl
    const jsonl = await readJsonlIfExists(path.join(ctx.root, "meta", "episodes.jsonl"));
    if (jsonl && jsonl.length > 0) {
      return jsonl.map((obj, i) => ({
        episodeIndex: Number(obj.episode_index ?? i),
        tasks: toStringArray(obj.tasks),
        length: Number(obj.length ?? 0),
        frameRange: parseFrameRange(obj),
        dataShard: parseDataShard(obj),
      })).sort((a, b) => a.episodeIndex - b.episodeIndex);
    }

    // 3. Aggregated json (some converters emit this)
    try {
      const aggregate = (await readJson(path.join(ctx.root, "meta", "episodes", "episodes_metadata.json"))) as {
        episodes?: Record<string, unknown>[];
      };
      if (Array.isArray(aggregate.episodes)) {
        return aggregate.episodes
          .map((obj, i) => ({
            episodeIndex: Number(obj.episode_index ?? i),
            tasks: toStringArray(obj.tasks),
            length: Number(obj.length ?? 0),
            frameRange: parseFrameRange(obj),
            dataShard: parseDataShard(obj),
          }))
          .sort((a, b) => a.episodeIndex - b.episodeIndex);
      }
    } catch {
      // not present — fall through
    }

    // 4. Last resort
    if (ctx.info.totalEpisodes === 0) {
      this.warnings.push(
        "No v3.0 episode metadata found (meta/episodes parquet, episodes.jsonl, or episodes_metadata.json).",
      );
      return [];
    }
    this.warnings.push(
      "Could not parse v3.0 episode metadata; using info.json totals only. Shard locations will fall back to file-000.",
    );
    return synthesizeEpisodes(ctx.info.totalEpisodes, ctx.info.totalFrames);
  }

  async loadTasks(ctx: AdapterContext): Promise<TaskInfo[]> {
    const file = path.join(ctx.root, "meta", "tasks.parquet");
    if (!(await exists(file))) return [];
    try {
      const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
      const buffer = await asyncBufferFromFile(file);
      const rows = (await parquetReadObjects({ file: buffer })) as Record<string, unknown>[];
      return rows
        .map((row, i): TaskInfo => {
          // Older converters use a pandas index column literally named
          // `__index_level_0__` for the task description.
          const text =
            (typeof row.task === "string" && row.task) ||
            (typeof row.description === "string" && row.description) ||
            (typeof row.__index_level_0__ === "string" && row.__index_level_0__) ||
            "";
          const idxRaw = row.task_index;
          const idx =
            typeof idxRaw === "number"
              ? idxRaw
              : typeof idxRaw === "bigint"
                ? Number(idxRaw)
                : i;
          return { taskIndex: idx, task: text };
        })
        .filter((t) => t.task.length > 0);
    } catch (err) {
      this.warnings.push(`Could not parse meta/tasks.parquet: ${(err as Error).message}`);
      return [];
    }
  }

  async resolveVideo(
    ctx: AdapterContext,
    episode: LeRobotEpisode,
    videoKey: string,
  ): Promise<VideoLocation | undefined> {
    const template = ctx.info.videoPath ?? DEFAULT_VIDEO_TEMPLATE_V3;
    const chunkSize = ctx.info.chunksSize ?? 1000;

    let chunkIndex: number;
    let fileIndex: number;
    let note: string | undefined;
    const videoShard = episode.videoShards?.[videoKey];
    if (videoShard) {
      chunkIndex = videoShard.chunkIndex;
      fileIndex = videoShard.fileIndex;
    } else if (episode.dataShard) {
      // Same-shard assumption: data and video shards usually align in v3.0
      // for simple datasets. If the per-video metadata is missing we use the
      // data shard and surface a soft note.
      chunkIndex = episode.dataShard.chunkIndex;
      fileIndex = episode.dataShard.fileIndex;
      note = `v3.0 video shard for ${videoKey} not in episodes metadata; using data shard.`;
    } else {
      chunkIndex = Math.floor(episode.episodeIndex / chunkSize);
      fileIndex = 0;
      note = "v3.0 shard index unknown; falling back to file-000.";
    }

    const filled = buildVideoPath({
      template,
      chunkIndex,
      fileIndex,
      episodeIndex: episode.episodeIndex,
      videoKey,
    });
    const abs = joinPath(ctx.root, filled);
    if (!(await exists(abs))) return undefined;
    const location: VideoLocation = { path: abs };
    if (episode.frameRange) location.shardFrameRange = episode.frameRange;
    if (note) location.note = note;
    return location;
  }
}

// --------------------------------------------------------------------------

async function listEpisodeShardFiles(root: string): Promise<string[]> {
  const base = path.join(root, "meta", "episodes");
  const out: string[] = [];
  let chunks: string[];
  try {
    chunks = await fs.readdir(base);
  } catch {
    return out;
  }
  for (const chunk of chunks.sort()) {
    const chunkPath = path.join(base, chunk);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(chunkPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const inner = await fs.readdir(chunkPath).catch(() => [] as string[]);
      for (const f of inner.sort()) {
        if (f.endsWith(".parquet")) out.push(path.join(chunkPath, f));
      }
    } else if (chunk.endsWith(".parquet")) {
      out.push(chunkPath);
    }
  }
  return out;
}

async function readEpisodesFromParquet(files: string[]): Promise<LeRobotEpisode[]> {
  const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
  const out: LeRobotEpisode[] = [];
  for (const file of files) {
    const buffer = await asyncBufferFromFile(file);
    const rows = (await parquetReadObjects({ file: buffer })) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    const videoKeys = discoverVideoKeys(Object.keys(rows[0]));
    for (const row of rows) {
      out.push(extractEpisode(row, videoKeys));
    }
  }
  out.sort((a, b) => a.episodeIndex - b.episodeIndex);
  return out;
}

function discoverVideoKeys(columns: string[]): string[] {
  const keys = new Set<string>();
  for (const col of columns) {
    const m = col.match(/^videos\/(.+)\/chunk_index$/);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

function extractEpisode(row: Record<string, unknown>, videoKeys: string[]): LeRobotEpisode {
  const episodeIndex = toInt(row.episode_index) ?? 0;
  const length = toInt(row.length) ?? 0;
  const tasks = toStringArray(row.tasks);
  const dataChunk = toInt(row["data/chunk_index"]);
  const dataFile = toInt(row["data/file_index"]);
  const from = toInt(row.dataset_from_index);
  const to = toInt(row.dataset_to_index);

  const videoShards: Record<string, ShardLocation> = {};
  const videoRanges: Record<string, [number, number]> = {};
  for (const key of videoKeys) {
    const c = toInt(row[`videos/${key}/chunk_index`]);
    const f = toInt(row[`videos/${key}/file_index`]);
    if (c !== undefined && f !== undefined) {
      videoShards[key] = { chunkIndex: c, fileIndex: f };
    }
    const fromTs = toFloat(row[`videos/${key}/from_timestamp`]);
    const toTs = toFloat(row[`videos/${key}/to_timestamp`]);
    if (fromTs !== undefined && toTs !== undefined) {
      videoRanges[key] = [fromTs, toTs];
    }
  }

  const ep: LeRobotEpisode = { episodeIndex, tasks, length };
  if (from !== undefined && to !== undefined) ep.frameRange = [from, to];
  if (dataChunk !== undefined && dataFile !== undefined) {
    ep.dataShard = { chunkIndex: dataChunk, fileIndex: dataFile };
  }
  if (Object.keys(videoShards).length > 0) ep.videoShards = videoShards;
  if (Object.keys(videoRanges).length > 0) ep.videoRanges = videoRanges;
  return ep;
}

// --------------------------------------------------------------------------

function parseFrameRange(obj: Record<string, unknown>): [number, number] | undefined {
  const from = obj.dataset_from_index ?? obj.from_index ?? obj.frame_from;
  const to = obj.dataset_to_index ?? obj.to_index ?? obj.frame_to;
  const fromN = toInt(from);
  const toN = toInt(to);
  if (fromN !== undefined && toN !== undefined) return [fromN, toN];
  return undefined;
}

function parseDataShard(obj: Record<string, unknown>): ShardLocation | undefined {
  const c = toInt(obj["data/chunk_index"] ?? obj.data_chunk_index ?? obj.chunk_index);
  const f = toInt(obj["data/file_index"] ?? obj.data_file_index ?? obj.file_index);
  if (c === undefined || f === undefined) return undefined;
  return { chunkIndex: c, fileIndex: f };
}

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function toFloat(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

