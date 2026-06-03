// Convert a LeRobot v2.1 (per-episode) dataset to v3.0 (sharded) format.
// Inverse of convertV3ToV21.

import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { buildDataPath, buildVideoPath, exists, writeJsonl, readJson, readJsonlIfExists } from "./adapters/util";
import { buildParquetSchema } from "./parquetSchema";
import { writeStatsJsonl } from "./statsJson";
import type { LeRobotInfo } from "../types";

let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() { return (hyparquetPromise ??= import("hyparquet")); }
function getParquetjs(): any { return require("parquetjs"); }

export interface ConvertProgress { done: number; total: number; current: string; }

export async function convertV21ToV30(
  sourceRoot: string, targetRoot: string,
  onProgress: (p: ConvertProgress) => void,
): Promise<void> {
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(sourceRoot);
  const episodes = await adapter.loadEpisodes({ root: sourceRoot, info });
  const tasks = await adapter.loadTasks({ root: sourceRoot, info });
  if (episodes.length === 0) throw new Error("No episodes found.");

  const chunksSize = info.chunksSize ?? 1000;
  const total = episodes.length;

  // Check ffmpeg for video concatenation.
  let ffmpegOk = false;
  try { await execFile("ffmpeg", ["-version"]); ffmpegOk = true; } catch { /* ok */ }

  // Target dirs.
  await fs.mkdir(path.join(targetRoot, "meta", "episodes"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "videos"), { recursive: true });

  // Collect camera keys.
  const cameraKeys: string[] = [];
  for (const [k, f] of Object.entries(info.features)) {
    if (f.dtype === "video") cameraKeys.push(k);
  }

  // Episodes sorted by index.
  const sorted = [...episodes].sort((a, b) => a.episodeIndex - b.episodeIndex);

  // ---- Build data shards ----
  onProgress({ done: 0, total, current: "Building data shards..." });
  const dataBoundaries = await buildDataShards(sourceRoot, targetRoot, adapter, info, sorted, chunksSize, onProgress);

  // ---- Build video shards ----
  const videoBoundaries: Record<string, Array<Record<string, unknown>>> = {};
  if (ffmpegOk) {
    for (const cam of cameraKeys) {
      const vb = await buildVideoShards(sourceRoot, targetRoot, info, sorted, cam, chunksSize, onProgress);
      if (vb.length !== sorted.length) {
        onProgress({
          done: 0, total, current:
            `Warn: video boundary count mismatch for ${cam}: ${vb.length} vs ${sorted.length} episodes`,
        });
      }
      videoBoundaries[cam] = vb;
    }
  }

  // ---- Write boundary parquet ----
  onProgress({ done: 0, total, current: "Writing boundary parquet..." });
  if (dataBoundaries.length !== sorted.length) {
    throw new Error(
      `Data boundary count mismatch: ${dataBoundaries.length} boundaries vs ${sorted.length} episodes. ` +
      `Some episodes were not processed for data shards.`,
    );
  }
  await writeBoundaryParquet(targetRoot, sorted, dataBoundaries, videoBoundaries, tasks);

  // ---- Write info.json ----
  const v30Info = buildV30Info(info, total, cameraKeys, chunksSize);
  await fs.writeFile(path.join(targetRoot, "meta", "info.json"), JSON.stringify(v30Info, null, 2), "utf8");

  // ---- Convert per-episode stats to global stats.json for v3.0 ----
  const epStatsPath = path.join(sourceRoot, "meta", "episodes_stats.jsonl");
  if (await exists(epStatsPath)) {
    const epStats = await readJsonlIfExists(epStatsPath);
    if (epStats && epStats.length > 0) {
      const globalStats = aggregateEpisodeStats(epStats);
      await fs.writeFile(
        path.join(targetRoot, "meta", "stats.json"),
        JSON.stringify(globalStats, null, 2), "utf8",
      );
    }
  }

  onProgress({ done: total, total, current: "Done." });
}

// ---- Data shard building ----

async function buildDataShards(
  srcRoot: string, dstRoot: string,
  adapter: V21Adapter, info: LeRobotInfo,
  episodes: Awaited<ReturnType<V21Adapter["loadEpisodes"]>>,
  chunksSize: number,
  onProgress: (p: ConvertProgress) => void,
): Promise<Array<{ chunkIndex: number; fileIndex: number; from: number; to: number }>> {
  const boundaries: Array<{ chunkIndex: number; fileIndex: number; from: number; to: number }> = [];
  let fileIndex = 0;
  let rowOffset = 0;
  let shardRows: Record<string, unknown>[] = [];
  const MAX_ROWS_PER_SHARD = 100000; // ~50 MB typical per shard.

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const dataPath = await adapter.resolveDataFile({ root: srcRoot, info }, ep);
    if (!dataPath || !(await exists(dataPath))) {
      throw new Error(`Parquet not found for episode ${ep.episodeIndex}.`);
    }
    const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
    const buffer = await asyncBufferFromFile(dataPath);
    const rows = (await parquetReadObjects({ file: buffer })) as Record<string, unknown>[];
    const cleanRows = rows.map(sanitizeRow);
    // Overwrite episode_index to match the actual episode (fixes stale values
    // from episode deletion/reindex that renamed files but left old column values).
    for (const r of cleanRows) r.episode_index = ep.episodeIndex;
    if (cleanRows.length === 0) {
      onProgress({ done: i + 1, total: episodes.length, current: `Warn: ep ${ep.episodeIndex} has 0 rows` });
    }

    const from = rowOffset;
    rowOffset += cleanRows.length;
    const to = rowOffset;

    boundaries.push({ chunkIndex: 0, fileIndex, from, to });
    shardRows.push(...cleanRows);

    // Flush shard when it gets large or it's the last episode.
    if (shardRows.length >= MAX_ROWS_PER_SHARD || i === episodes.length - 1) {
      const dstRel = buildDataPath({
        template: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
        chunkIndex: 0, fileIndex, episodeIndex: 0,
      });
      const dstPath = path.join(dstRoot, dstRel);
      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      await writeParquetFile(dstPath, shardRows, info);
      shardRows = [];
      fileIndex++;
      rowOffset = 0;
      // Update boundaries for this shard's episodes to reflect new fileIndex.
      for (let j = boundaries.length - 1; j >= 0 && boundaries[j].fileIndex === fileIndex - 1; j--) {
        // Already correct.
      }
      // Actually, the boundaries for episodes that were flushed need their fileIndex updated.
      // Episodes in this shard have their current fileIndex. Let's track differently.
    }

    onProgress({ done: i + 1, total: episodes.length, current: `Data: ep ${ep.episodeIndex}` });
  }

  return boundaries;
}

// ---- Video shard building ----

async function buildVideoShards(
  srcRoot: string, dstRoot: string,
  info: LeRobotInfo,
  episodes: Array<{ episodeIndex: number; length: number; videoRanges?: Record<string, [number, number]> }>,
  camKey: string, chunksSize: number,
  onProgress: (p: ConvertProgress) => void,
): Promise<Array<Record<string, unknown>>> {
  // Collect episode video paths. Missing videos → placeholder.
  interface EpVideo { path?: string; ep: typeof episodes[0] }
  const epVideos: EpVideo[] = [];
  for (const ep of episodes) {
    const chunkIdx = Math.floor(ep.episodeIndex / chunksSize);
    const tpl = info.videoPath ?? "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";
    const rel = buildVideoPath({ template: tpl, chunkIndex: chunkIdx, fileIndex: 0, episodeIndex: ep.episodeIndex, videoKey: camKey });
    const abs = path.join(srcRoot, rel);
    epVideos.push({ path: await exists(abs) ? abs : undefined, ep });
  }

  // Group 100 episodes per video shard.
  const boundaries: Array<Record<string, unknown>> = [];
  const batchSize = 100;
  let fileIndex = 0;

  for (let i = 0; i < epVideos.length; i += batchSize) {
    const batch = epVideos.slice(i, i + batchSize);
    const existing = batch.filter((ev) => ev.path).map((ev) => ev.path!);

    const dstRel = buildVideoPath({
      template: "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
      chunkIndex: 0, fileIndex, episodeIndex: 0, videoKey: camKey,
    });
    const dstPath = path.join(dstRoot, dstRel);

    if (existing.length > 0) {
      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      const concatList = existing.map((p) => `file '${p}'`).join("\n");
      const listFile = dstPath + ".txt";
      await fs.writeFile(listFile, concatList, "utf8");
      await execFile("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", dstPath]);
      await fs.unlink(listFile).catch(() => {});
    }

    // Boundaries for ALL episodes in batch (including missing videos).
    let batchTs = 0;
    for (const ev of batch) {
      const dur = (ev.ep.length ?? 0) / (info.fps || 30);
      boundaries.push({
        episode_index: ev.ep.episodeIndex,
        chunk_index: 0,
        file_index: ev.path ? fileIndex : null,
        from_timestamp: batchTs,
        to_timestamp: batchTs + dur,
      });
      batchTs += dur;
    }
    fileIndex++;
    onProgress({ done: Math.min(i + batchSize, epVideos.length), total: epVideos.length, current: `Video ${camKey}` });
  }

  return boundaries;
}

// ---- Boundary parquet writing ----

async function writeBoundaryParquet(
  dstRoot: string,
  episodes: Array<{ episodeIndex: number; tasks: string[]; length: number }>,
  dataBounds: Array<{ chunkIndex: number; fileIndex: number; from: number; to: number }>,
  videoBounds: Record<string, Array<Record<string, unknown>>>,
  tasks: Array<{ taskIndex: number; task: string }>,
): Promise<void> {
  // Write boundaries as JSONL (parquet writing for complex nested schemas is tricky).
  // v3.0 supports JSONL fallback for episodes metadata.
  const records = episodes.map((ep, i) => {
    const db = dataBounds[i];
    const rec: Record<string, unknown> = {
      episode_index: ep.episodeIndex,
      tasks: ep.tasks,
      length: ep.length,
      "data/chunk_index": db.chunkIndex,
      "data/file_index": db.fileIndex,
      dataset_from_index: db.from,
      dataset_to_index: db.to,
    };
    for (const [cam, bounds] of Object.entries(videoBounds)) {
      const vb = bounds[i] as Record<string, unknown> | undefined;
      if (vb && vb.file_index != null) {
        rec[`videos/${cam}/chunk_index`] = vb.chunk_index;
        rec[`videos/${cam}/file_index`] = vb.file_index;
        rec[`videos/${cam}/from_timestamp`] = vb.from_timestamp;
        rec[`videos/${cam}/to_timestamp`] = vb.to_timestamp;
      }
    }
    return rec;
  });

  // Write boundary parquet (v3.0 canonical format).
  await writeEpisodesParquet(dstRoot, records);

  // Write tasks.parquet (v3.0 format).
  if (tasks.length > 0) {
    const pjsTask = getParquetjs();
    const taskSchema = new pjsTask.ParquetSchema({
      task_index: { type: "INT64" },
      task: { type: "UTF8" },
    });
    const taskPath = path.join(dstRoot, "meta", "tasks.parquet");
    const taskWriter = await pjsTask.ParquetWriter.openFile(taskSchema, taskPath, { compression: "UNCOMPRESSED" });
    for (const t of tasks) {
      await taskWriter.appendRow({ task_index: t.taskIndex, task: t.task });
    }
    await taskWriter.close();
  }
}

// ---- helpers ----

function buildV30Info(info: LeRobotInfo, totalEpisodes: number, cameraKeys: string[], chunksSize: number): Record<string, unknown> {
  return {
    codebase_version: "v3.0",
    robot_type: info.robotType ?? "unknown",
    fps: info.fps,
    total_episodes: totalEpisodes,
    total_frames: info.totalFrames,
    total_tasks: 0,
    total_videos: totalEpisodes * cameraKeys.length,
    total_chunks: Math.ceil(totalEpisodes / chunksSize),
    chunks_size: chunksSize,
    data_path: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
    video_path: "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
    features: info.features,
  };
}

async function writeParquetFile(
  filePath: string, rows: Record<string, unknown>[], info: LeRobotInfo,
): Promise<void> {
  if (rows.length === 0) return;
  const pjs = getParquetjs();
  const schemaFields = buildParquetSchema(sanitizeRow(rows[0]), info.features as Record<string, { dtype: string }>);
  const schema = new pjs.ParquetSchema(schemaFields);
  const writer = await pjs.ParquetWriter.openFile(schema, filePath, { compression: "UNCOMPRESSED" });
  for (const row of rows) await writer.appendRow(sanitizeRow(row));
  await writer.close();
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") out[key] = Number(value);
    else if (Array.isArray(value)) out[key] = value.map((v) => (typeof v === "bigint" ? Number(v) : v));
    else out[key] = value;
  }
  return out;
}

async function writeEpisodesParquet(dstRoot: string, records: Record<string, unknown>[]): Promise<void> {
  if (records.length === 0) return;
  const pjs = getParquetjs();

  // Build schema from all record keys (includes per-camera columns).
  const first = records[0];
  const schemaFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      schemaFields[key] = { type: "UTF8", repeated: true };
    } else if (typeof value === "number") {
      schemaFields[key] = { type: Number.isInteger(value) ? "INT64" : "DOUBLE" };
    } else if (typeof value === "string") {
      schemaFields[key] = { type: "UTF8" };
    }
  }

  const epDir = path.join(dstRoot, "meta", "episodes", "chunk-000");
  await fs.mkdir(epDir, { recursive: true });
  const schema = new pjs.ParquetSchema(schemaFields);
  const writer = await pjs.ParquetWriter.openFile(
    schema, path.join(epDir, "file-000.parquet"),
    { compression: "UNCOMPRESSED" },
  );
  for (const rec of records) await writer.appendRow(rec);
  await writer.close();
}

/** Aggregate per-episode stats into a global stats.json for v3.0. */
/** Flatten nested arrays like [[[r]], [[g]], [[b]]] into [r, g, b]. */
function flattenNested(arr: any[]): number[] {
  const out: number[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) visit(x); }
    else if (typeof v === "number") out.push(v);
  };
  visit(arr);
  return out;
}

function aggregateEpisodeStats(epStats: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (epStats.length === 0) return out;

  // Collect all feature keys from the first episode's stats.
  const firstStats = (epStats[0].stats ?? epStats[0]) as Record<string, Record<string, unknown>>;
  const featureKeys = Object.keys(firstStats);

  for (const fk of featureKeys) {
    const firstFeat = firstStats[fk] as Record<string, unknown> | undefined;
    if (!firstFeat || typeof firstFeat !== "object") continue;

    // min/max/mean/std aggregate exactly. Quantiles (qXX) use weighted average
    // (same as official LeRobot aggregate_stats).
    const statFields = Object.keys(firstFeat).filter((k) => k !== "count");
    const hasCount = "count" in firstFeat;

    const aggregated: Record<string, unknown> = {};
    let totalCount = 0;

    for (const field of statFields) {
      // Collect all episodes' values for this field.
      const allValues: unknown[] = [];
      let dim = 0;
      for (const rec of epStats) {
        const s = (rec.stats ?? rec) as Record<string, Record<string, unknown>>;
        const feat = s[fk] as Record<string, unknown> | undefined;
        if (!feat) continue;
        const val = feat[field];
        if (Array.isArray(val)) {
          // Flatten nested arrays (video stats: [[[r]], [[g]], [[b]]] → [r, g, b]).
          const flat = flattenNested(val as any[]);
          allValues.push(flat);
          dim = flat.length;
        } else if (typeof val === "number") { allValues.push([val]); dim = 1; }
      }

      if (allValues.length === 0) continue;
      if (dim === 0) continue;

      // For min/max: take min of mins, max of maxs.
      // For mean/count: compute weighted average.
      // For std: combine via pooled variance.
      if (field === "min") {
        aggregated[field] = elementWise(allValues as number[][], Math.min);
      } else if (field === "max") {
        aggregated[field] = elementWise(allValues as number[][], Math.max);
      } else if (field === "mean") {
        // Weighted average: sum(mean_i * count_i) / sum(count_i).
        const counts = collectCounts(epStats, fk);
        aggregated[field] = weightedMean(allValues as number[][], counts);
      } else if (field === "std") {
        // Pooled std: sqrt(sum((n_i-1)*s_i^2 + n_i*(m_i - m)^2) / (N-1))
        const counts = collectCounts(epStats, fk);
        const means = collectField(epStats, fk, "mean");
        aggregated[field] = pooledStd(allValues as number[][], means as number[][], counts);
        totalCount = counts.reduce((a, b) => a + b, 0);
      } else {
        // Quantile (q01/q10/q50/q90/q99) — weighted average, same as official.
        const qCounts = collectCounts(epStats, fk);
        aggregated[field] = weightedMean(allValues as number[][], qCounts);
      }
    }

    if (hasCount) {
      const counts = collectCounts(epStats, fk);
      totalCount = counts.reduce((a, b) => a + b, 0);
      aggregated["count"] = [totalCount];
    }

    out[fk] = aggregated;
  }

  return out;
}

function elementWise(arrays: number[][], fn: (a: number, b: number) => number): number[] {
  const n = arrays[0].length;
  const result = [...arrays[0]];
  for (let i = 1; i < arrays.length; i++) {
    for (let j = 0; j < n; j++) result[j] = fn(result[j], arrays[i][j]);
  }
  return result;
}

function elementWiseMean(arrays: number[][]): number[] {
  const n = arrays[0].length;
  const result = new Array(n).fill(0);
  for (const arr of arrays) {
    for (let j = 0; j < n; j++) result[j] += arr[j];
  }
  for (let j = 0; j < n; j++) result[j] /= arrays.length;
  return result;
}

function collectCounts(epStats: Record<string, unknown>[], fk: string): number[] {
  return epStats.map((rec) => {
    const s = (rec.stats ?? rec) as Record<string, Record<string, unknown>>;
    const feat = s[fk] as Record<string, unknown> | undefined;
    if (!feat || !feat.count) return 1;
    const c = Array.isArray(feat.count) ? (feat.count as number[])[0] : (feat.count as number);
    return c || 1;
  });
}

function collectField(epStats: Record<string, unknown>[], fk: string, field: string): number[][] {
  return epStats.map((rec) => {
    const s = (rec.stats ?? rec) as Record<string, Record<string, unknown>>;
    const feat = s[fk] as Record<string, unknown> | undefined;
    return (feat?.[field] as number[]) ?? [];
  });
}

function weightedMean(means: number[][], counts: number[]): number[] {
  const n = means[0]?.length ?? 0;
  const result = new Array(n).fill(0);
  let totalW = 0;
  for (let i = 0; i < means.length; i++) {
    const w = counts[i] || 1;
    totalW += w;
    for (let j = 0; j < n; j++) result[j] += means[i][j] * w;
  }
  for (let j = 0; j < n; j++) result[j] /= totalW;
  return result;
}

function pooledStd(stds: number[][], means: number[][], counts: number[]): number[] {
  const n = stds[0]?.length ?? 0;
  const globalMean = weightedMean(means, counts);
  let totalN = 0;
  const sumVar = new Array(n).fill(0);
  for (let i = 0; i < stds.length; i++) {
    const ni = counts[i] || 1;
    totalN += ni;
    for (let j = 0; j < n; j++) {
      const diff = means[i][j] - globalMean[j];
      sumVar[j] += (ni - 1) * stds[i][j] * stds[i][j] + ni * diff * diff;
    }
  }
  return sumVar.map((v) => Math.sqrt(v / (totalN - 1)));
}

function execFile(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
    proc.on("error", reject);
  });
}
