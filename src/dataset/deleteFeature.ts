// Delete a feature (camera or data column) from a v2.x dataset.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { buildVideoPath, exists, readJson } from "./adapters/util";
import { buildParquetSchema } from "./parquetSchema";
import { writeStatsJsonl } from "./statsJson";
import type { LeRobotEpisode, LeRobotInfo } from "../types";

let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() {
  return (hyparquetPromise ??= import("hyparquet"));
}
function getParquetjs(): any {
  return require("parquetjs");
}

export interface DeleteFeatureProgress {
  done: number;
  total: number;
}

export async function deleteFeature(
  root: string,
  featureKey: string,
  onProgress: (p: DeleteFeatureProgress) => void,
): Promise<void> {
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  const feat = info.features[featureKey];
  if (!feat) throw new Error(`Feature "${featureKey}" not found.`);

  const isVideo = feat.dtype === "video" || featureKey.startsWith("observation.images.");

  // 1. Update info.json.
  const infoRaw = await readJson(path.join(root, "meta", "info.json"));
  const features = infoRaw.features as Record<string, Record<string, unknown>>;
  delete features[featureKey];
  if (isVideo) {
    const prevVideos = (infoRaw.total_videos as number) ?? 0;
    const epCount = episodes.length;
    infoRaw.total_videos = prevVideos - epCount;
  }
  await fs.writeFile(
    path.join(root, "meta", "info.json"),
    JSON.stringify(infoRaw, null, 2),
    "utf8",
  );

  // 2. Delete video files + clean up empty directories.
  if (isVideo) {
    const total = episodes.length;
    const cleanedDirs = new Set<string>();
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const videoPaths = await findVideoFiles(root, info, ep, featureKey);
      for (const vp of videoPaths) {
        try {
          await fs.unlink(vp);
          cleanedDirs.add(path.dirname(vp));
        } catch { /* file may already be gone */ }
      }
      onProgress({ done: i + 1, total });
    }
    // Remove empty per-video-feature directories (and their parents if empty).
    for (const dir of cleanedDirs) {
      await removeEmptyDirs(dir, path.join(root, "videos"));
    }
  } else {
    // 3. Rewrite parquet files (remove column for matrix/scalar features).
    const total = episodes.length;
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const dataPath = await adapter.resolveDataFile({ root, info }, ep);
      if (!dataPath || !(await exists(dataPath))) {
        throw new Error(`Parquet not found for episode ${ep.episodeIndex}.`);
      }
      const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
      const buffer = await asyncBufferFromFile(dataPath);
      const rows = (await parquetReadObjects({ file: buffer })) as Record<string, unknown>[];

      const pjs = getParquetjs();
      const cleanRows = rows.map(sanitizeRow).map((r) => { delete r[featureKey]; return r; });
      const schemaFields = buildParquetSchema(cleanRows[0], infoRaw.features as Record<string, { dtype: string }>);
      const schema = new pjs.ParquetSchema(schemaFields);

      const tmpPath = dataPath + ".tmp";
      const writer = await pjs.ParquetWriter.openFile(schema, tmpPath, { compression: "UNCOMPRESSED" });
      for (const row of cleanRows) await writer.appendRow(row);
      await writer.close();
      await fs.rename(tmpPath, dataPath);
      onProgress({ done: i + 1, total });
    }
  }

  // 4. Remove the deleted feature from stats (other features' stats stay valid).
  await removeFromStats(root, featureKey);
}

/** Recursively remove `dir` and its empty ancestors up to (but not including) `stopDir`. */
async function removeEmptyDirs(dir: string, stopDir: string): Promise<void> {
  let current = dir;
  while (current !== stopDir) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length === 0) {
        await fs.rmdir(current);
      } else {
        break;
      }
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

const VIDEO_EXTENSIONS = [".mp4", ".avi", ".mkv", ".mov", ".webm"];

async function findVideoFiles(
  root: string,
  info: LeRobotInfo,
  episode: LeRobotEpisode,
  videoKey: string,
): Promise<string[]> {
  const chunksSize = info.chunksSize ?? 1000;
  const chunkIdx = Math.floor(episode.episodeIndex / chunksSize);
  const baseTpl = info.videoPath ?? "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";
  const out: string[] = [];

  // Try each supported extension against the template.
  for (const ext of VIDEO_EXTENSIONS) {
    const tpl = baseTpl.replace(/\.\w+$/, ext);
    const rel = buildVideoPath({ template: tpl, chunkIndex: chunkIdx, fileIndex: 0, episodeIndex: episode.episodeIndex, videoKey });
    const abs = path.join(root, rel);
    if (await exists(abs)) out.push(abs);
  }

  // Fallback: if the directory exists, scan for any video files in it.
  if (out.length === 0) {
    const dirRel = buildVideoPath({ template: baseTpl, chunkIndex: chunkIdx, fileIndex: 0, episodeIndex: episode.episodeIndex, videoKey });
    const dir = path.dirname(path.join(root, dirRel));
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith("episode_") || entry.startsWith("file-")) {
          const full = path.join(dir, entry);
          if (VIDEO_EXTENSIONS.some((e) => entry.endsWith(e))) {
            out.push(full);
          }
        }
      }
    } catch { /* dir may not exist */ }
  }

  return out;
}

async function removeFromStats(root: string, featureKey: string): Promise<void> {
  const epStatsPath = path.join(root, "meta", "episodes_stats.jsonl");
  if (await exists(epStatsPath)) {
    try {
      const text = await fs.readFile(epStatsPath, "utf8");
      const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      for (const line of lines) {
        // Feature keys may be at top level or nested under "stats".
        delete line[featureKey];
        const stats = line.stats as Record<string, unknown> | undefined;
        if (stats) delete stats[featureKey];
      }
      await writeStatsJsonl(epStatsPath, lines);
    } catch { /* ok */ }
  }
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
