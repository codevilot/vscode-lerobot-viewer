// Fix stale episode_index column values in v2.x parquet files.
// After episode deletion + reindex, files are renamed but the internal
// episode_index column still has the old value.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { exists } from "./adapters/util";

let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() { return (hyparquetPromise ??= import("hyparquet")); }
function getParquetjs(): any { return require("parquetjs"); }

export interface FixProgress { done: number; total: number; }

export async function fixEpisodeIndex(
  root: string,
  onProgress: (p: FixProgress) => void,
): Promise<number> {
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  if (episodes.length === 0) return 0;

  const chunksSize = info.chunksSize ?? 1000;
  let fixed = 0;
  const total = episodes.length;

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const dataPath = await adapter.resolveDataFile({ root, info }, ep);
    if (!dataPath || !(await exists(dataPath))) {
      onProgress({ done: i + 1, total });
      continue;
    }
    const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
    const buffer = await asyncBufferFromFile(dataPath);
    const rows = (await parquetReadObjects({ file: buffer })) as Record<string, unknown>[];
    if (rows.length === 0) { onProgress({ done: i + 1, total }); continue; }

    if (Number(rows[0].episode_index) === ep.episodeIndex) {
      onProgress({ done: i + 1, total });
      continue;
    }

    // Fix episode_index in all rows.
    for (const r of rows) r.episode_index = ep.episodeIndex;
    // Sanitize bigints.
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === "bigint") (r as any)[k] = Number(v);
        else if (Array.isArray(v)) (r as any)[k] = (v as unknown[]).map((x) => typeof x === "bigint" ? Number(x) : x);
      }
    }
    // Write back.
    const pjs = getParquetjs();
    const first = rows[0];
    const sf: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first)) {
      if (v === null || v === undefined) continue;
      const isArr = Array.isArray(v);
      const s = isArr ? (v as unknown[])[0] : v;
      const t = typeof s === "number" ? (Number.isInteger(s) ? "INT64" : "DOUBLE") : typeof s === "boolean" ? "BOOLEAN" : "UTF8";
      sf[k] = isArr ? { type: t, repeated: true } : { type: t };
    }
    const schema = new pjs.ParquetSchema(sf);
    const tmpPath = dataPath + ".tmp";
    const writer = await pjs.ParquetWriter.openFile(schema, tmpPath, { compression: "UNCOMPRESSED" });
    for (const r of rows) await writer.appendRow(r);
    await writer.close();
    await fs.rename(tmpPath, dataPath);
    fixed++;
    onProgress({ done: i + 1, total });
  }
  return fixed;
}
