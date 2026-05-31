// Delete a feature (camera or data column) from a v2.x dataset.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { buildVideoPath, exists, readJson, writeJsonl } from "./adapters/util";

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

  // 2. Delete video files (cameras only).
  if (isVideo) {
    const total = episodes.length;
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const videoPaths = await findVideoFiles(root, info, ep, featureKey);
      for (const vp of videoPaths) {
        try { await fs.unlink(vp); } catch { /* ok */ }
      }
      onProgress({ done: i + 1, total });
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
      const schemaFields = buildSchema(cleanRows[0]);
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

async function findVideoFiles(
  root: string,
  info: import("../../types").LeRobotInfo,
  episode: import("../../types").LeRobotEpisode,
  videoKey: string,
): Promise<string[]> {
  // Try multiple chunk sizes and layouts to find the video file.
  const chunksSize = info.chunksSize ?? 1000;
  const chunkIdx = Math.floor(episode.episodeIndex / chunksSize);
  const templates = [
    info.videoPath ?? "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
  ];
  const out: string[] = [];
  for (const tpl of templates) {
    const rel = buildVideoPath({ template: tpl, chunkIndex: chunkIdx, fileIndex: 0, episodeIndex: episode.episodeIndex, videoKey });
    const abs = path.join(root, rel);
    if (await exists(abs)) out.push(abs);
  }
  return out;
}

async function removeFromStats(root: string, featureKey: string): Promise<void> {
  const statsPath = path.join(root, "meta", "stats.json");
  if (await exists(statsPath)) {
    try {
      const raw = await readJson(statsPath);
      delete (raw as Record<string, unknown>)[featureKey];
      await fs.writeFile(statsPath, JSON.stringify(raw, null, 2), "utf8");
    } catch { /* ok */ }
  }
  const epStatsPath = path.join(root, "meta", "episodes_stats.jsonl");
  if (await exists(epStatsPath)) {
    try {
      const text = await fs.readFile(epStatsPath, "utf8");
      const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      for (const line of lines) delete line[featureKey];
      const { writeJsonl } = await import("./adapters/util");
      await writeJsonl(epStatsPath, lines);
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

function buildSchema(row: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const s = value[0];
      const t = typeof s === "number" ? (Number.isInteger(s) ? "INT64" : "DOUBLE") : "UTF8";
      fields[key] = { type: t, repeated: true };
    } else if (typeof value === "number") {
      fields[key] = { type: Number.isInteger(value) ? "INT64" : "DOUBLE" };
    } else if (typeof value === "boolean") {
      fields[key] = { type: "BOOLEAN" };
    } else {
      fields[key] = { type: "UTF8" };
    }
  }
  return fields;
}
