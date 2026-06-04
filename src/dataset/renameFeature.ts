// Rename a feature in a v2.x dataset. For data columns: rewrites parquet.
// For video features: renames video directories.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { exists, readJson, readJsonlIfExists } from "./adapters/util";
import { writeStatsJsonl } from "./statsJson";
import { buildParquetSchema } from "./parquetSchema";

let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() {
  return (hyparquetPromise ??= import("hyparquet"));
}
function getParquetjs(): any {
  return require("parquetjs");
}

export interface RenameProgress { done: number; total: number; }

export async function renameFeature(
  root: string, oldKey: string, newKey: string,
  onProgress: (p: RenameProgress) => void,
): Promise<void> {
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  const feat = info.features[oldKey];
  if (!feat) throw new Error(`Feature "${oldKey}" not found.`);
  if (info.features[newKey]) throw new Error(`Feature "${newKey}" already exists.`);

  const isVideo = feat.dtype === "video" || oldKey.startsWith("observation.images.");

  // 1. Update info.json.
  const infoRaw = await readJson(path.join(root, "meta", "info.json"));
  const features = infoRaw.features as Record<string, unknown>;
  features[newKey] = features[oldKey];
  delete features[oldKey];
  await fs.writeFile(
    path.join(root, "meta", "info.json"),
    JSON.stringify(infoRaw, null, 2), "utf8",
  );

  if (isVideo) {
    // 2a. Rename video directories (videos/chunk-XXX/oldKey → newKey).
    const videoDir = path.join(root, "videos");
    for (const chunk of await fs.readdir(videoDir).catch(() => [] as string[])) {
      const oldDir = path.join(videoDir, chunk, oldKey);
      const newDir = path.join(videoDir, chunk, newKey);
      if (await exists(oldDir)) {
        await fs.mkdir(path.dirname(newDir), { recursive: true });
        await fs.rename(oldDir, newDir);
      }
    }
    onProgress({ done: 1, total: 1 });
  } else {
    // 2b. Rewrite parquet files — rename the column in each episode.
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
      const clean = rows.map(sanitizeRow).map((r) => {
        if (oldKey in r) { r[newKey] = r[oldKey]; delete r[oldKey]; }
        return r;
      });
      const schemaFields = buildParquetSchema(clean[0], infoRaw.features as Record<string, { dtype: string }>);
      const schema = new pjs.ParquetSchema(schemaFields);

      const tmpPath = dataPath + ".tmp";
      const writer = await pjs.ParquetWriter.openFile(schema, tmpPath, { compression: "UNCOMPRESSED" });
      for (const row of clean) await writer.appendRow(row);
      await writer.close();
      await fs.rename(tmpPath, dataPath);
      onProgress({ done: i + 1, total: episodes.length });
    }
  }

  // 3. Update stats.
  await renameInStats(root, oldKey, newKey);
}

async function renameInStats(root: string, oldKey: string, newKey: string): Promise<void> {
  const epStatsPath = path.join(root, "meta", "episodes_stats.jsonl");
  if (await exists(epStatsPath)) {
    const oldStats = await readJsonlIfExists(epStatsPath);
    if (oldStats) {
      for (const rec of oldStats) {
        const s = (rec.stats ?? rec) as Record<string, unknown>;
        if (oldKey in s) { s[newKey] = s[oldKey]; delete s[oldKey]; }
      }
      await writeStatsJsonl(epStatsPath, oldStats);
    }
  }
  const statsPath = path.join(root, "meta", "stats.json");
  if (await exists(statsPath)) {
    const raw = await readJson(statsPath);
    if (oldKey in raw) { (raw as Record<string, unknown>)[newKey] = raw[oldKey]; delete raw[oldKey]; }
    await fs.writeFile(statsPath, JSON.stringify(raw, null, 2), "utf8");
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
