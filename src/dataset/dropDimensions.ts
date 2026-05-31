// Drop specific dimensions from a matrix feature (state, action, etc.) in a
// v2.x dataset. Each episode's parquet is rewritten with the trimmed column.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { exists, readJson } from "./adapters/util";

// Lazy imports — hyparquet (ESM), parquetjs (CJS).
let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() {
  return (hyparquetPromise ??= import("hyparquet"));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getParquetjs(): any {
  return require("parquetjs");
}

export interface DropProgress {
  done: number;
  total: number;
}

/**
 * Drop dimensions from `featureKey` in the v2.x dataset at `root`.
 * Only `keepIndices` are preserved; all other dimensions are removed.
 */
export async function dropDimensions(
  root: string,
  featureKey: string,
  keepIndices: number[],
  onProgress: (p: DropProgress) => void,
): Promise<void> {
  // 1. Load metadata.
  const infoRaw = await readJson(path.join(root, "meta", "info.json"));
  const feat = (infoRaw.features as Record<string, Record<string, unknown>>)?.[featureKey];
  if (!feat) throw new Error(`Feature "${featureKey}" not found in info.json.`);

  const oldShape = feat.shape as number[] | undefined;
  if (!oldShape || oldShape.length !== 1) {
    throw new Error(`Feature "${featureKey}" must be a 1-D array (got shape ${JSON.stringify(oldShape)}).`);
  }
  const oldDim = oldShape[0];
  const newDim = keepIndices.length;
  if (newDim === 0) throw new Error("Must keep at least one dimension.");
  if (newDim === oldDim && keepIndices.every((k, i) => k === i)) {
    throw new Error("No dimensions selected for removal — nothing to do.");
  }

  // Update feature names if present.
  const oldNames = feat.names as string[] | undefined;
  const newNames = oldNames ? keepIndices.map((k) => oldNames[k]) : undefined;

  // 2. Use the V21Adapter to properly resolve episode data files (handles
  // custom data_path templates, chunks_size, etc. correctly).
  const adapter = new V21Adapter();
  const adapterInfo = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info: adapterInfo });
  const total = episodes.length;
  const epStatsRecords: Record<string, unknown>[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const dataPath = await adapter.resolveDataFile({ root, info: adapterInfo }, ep);
    if (!dataPath || !(await exists(dataPath))) {
      throw new Error(
        `Parquet not found for episode ${ep.episodeIndex}: ` +
        `${dataPath ?? "(path could not be resolved)"}`,
      );
    }

    // Read → trim → write.
    const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
    const buffer = await asyncBufferFromFile(dataPath);
    const rows = (await parquetReadObjects({ file: buffer })) as Record<string, unknown>[];

    const pjs = getParquetjs();
    const firstRow = sanitizeRow(rows[0]);
    const schemaFields = buildSchema(firstRow);
    const schema = new pjs.ParquetSchema(schemaFields);

    const tmpPath = dataPath + ".tmp";
    const writer = await pjs.ParquetWriter.openFile(schema, tmpPath, { compression: "UNCOMPRESSED" });
    const trimmedRows: Record<string, unknown>[] = [];
    for (const row of rows) {
      const clean = sanitizeRow(row);
      // Drop dimensions from the target column.
      if (Array.isArray(clean[featureKey])) {
        const arr = clean[featureKey] as number[];
        clean[featureKey] = keepIndices.map((k) => arr[k]);
      }
      trimmedRows.push(clean);
      await writer.appendRow(clean);
    }
    await writer.close();

    // Per-episode stats.
    epStatsRecords.push({
      episode_index: ep.episodeIndex,
      ...computeEpStats(trimmedRows),
    });

    // Atomic replace.
    await fs.rename(tmpPath, dataPath);

    onProgress({ done: i + 1, total });
  }

  // 3. Update info.json.
  feat.shape = [newDim];
  if (newNames) feat.names = newNames;
  await fs.writeFile(
    path.join(root, "meta", "info.json"),
    JSON.stringify(infoRaw, null, 2),
    "utf8",
  );

  // 4. Write regenerated per-episode stats.
  if (epStatsRecords.length > 0) {
    const { writeJsonl } = await import("./adapters/util");
    await writeJsonl(path.join(root, "meta", "episodes_stats.jsonl"), epStatsRecords);
    // Remove global stats (invalidated by dimension change).
    try { await fs.unlink(path.join(root, "meta", "stats.json")); } catch { /* ok */ }
  }
}

// ---- helpers (shared patterns with convertV3ToV21) ----

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") {
      out[key] = Number(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === "bigint" ? Number(v) : v));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Compute per-episode min/max/mean/std for each numeric column. */
function computeEpStats(rows: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (rows.length === 0) return out;
  // Gather column keys from the first row.
  const keys = Object.keys(rows[0]).filter((k) => {
    const v = rows[0][k];
    if (v === null || v === undefined) return false;
    return typeof v === "number" || Array.isArray(v);
  });
  for (const key of keys) {
    const first = rows[0][key];
    const n = Array.isArray(first) ? (first as number[]).length : 1;
    const flat = rows.map((r) => {
      const v = r[key];
      return Array.isArray(v) ? (v as number[]) : [v as number];
    });
    const mins = new Array(n).fill(Infinity);
    const maxs = new Array(n).fill(-Infinity);
    const means = new Array(n).fill(0);
    const m2s = new Array(n).fill(0);
    const count = flat.length;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < n; j++) {
        const x = flat[i][j];
        if (x < mins[j]) mins[j] = x;
        if (x > maxs[j]) maxs[j] = x;
        const delta = x - means[j];
        means[j] += delta / (i + 1);
        const delta2 = x - means[j];
        m2s[j] += delta * delta2;
      }
    }
    out[key] = {
      min: mins,
      max: maxs,
      mean: means,
      std: m2s.map((m2) => Math.sqrt(m2 / count)),
    };
  }
  return out;
}

function buildSchema(row: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const sample = value[0];
      const t = typeof sample === "number"
        ? (Number.isInteger(sample) ? "INT64" : "DOUBLE")
        : "UTF8";
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
