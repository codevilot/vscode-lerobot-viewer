// Compute per-feature min/max/mean/std by scanning all episode parquet files.
// Writes meta/stats.json (global) and meta/episodes_stats.jsonl (per-episode).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./adapters/V21Adapter";
import { exists, writeJsonl, readJson } from "./adapters/util";
import type { LeRobotInfo } from "../types";

let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() {
  return (hyparquetPromise ??= import("hyparquet"));
}

export interface StatsProgress {
  done: number;
  total: number;
}

export async function recomputeStats(
  root: string,
  onProgress: (p: StatsProgress) => void,
): Promise<void> {
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  if (episodes.length === 0) throw new Error("No episodes found.");

  const resolveKey = featureKeyMap(info);
  const epStatsRecords: Record<string, unknown>[] = [];
  const globalAcc = new StatsAccumulator();

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const dataPath = await adapter.resolveDataFile({ root, info }, ep);
    if (!dataPath || !(await exists(dataPath))) {
      throw new Error(`Parquet not found for episode ${ep.episodeIndex}.`);
    }
    const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
    const buffer = await asyncBufferFromFile(dataPath);
    const rows = (await parquetReadObjects({ file: buffer })) as Record<string, unknown>[];
    const clean = rows.map(sanitizeRow);

    const epAcc = new StatsAccumulator();
    epAcc.ingest(clean);
    globalAcc.ingest(clean);
    epStatsRecords.push({
      episode_index: ep.episodeIndex,
      ...epAcc.toPerEpisode(resolveKey),
    });
    onProgress({ done: i + 1, total: episodes.length });
  }

  await writeJsonl(path.join(root, "meta", "episodes_stats.jsonl"), epStatsRecords);
  const globalStats = globalAcc.toPerEpisode(resolveKey);
  await fs.writeFile(
    path.join(root, "meta", "stats.json"),
    JSON.stringify(globalStats, null, 2),
    "utf8",
  );
}

// ---- stats accumulator (Welford online algorithm) ----

class StatsAccumulator {
  private mins = new Map<string, number[]>();
  private maxs = new Map<string, number[]>();
  private means = new Map<string, number[]>();
  private m2s = new Map<string, number[]>();
  private counts = new Map<string, number>();

  ingest(rows: Record<string, unknown>[]): void {
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        const arr = Array.isArray(value) ? (value as number[]) : [value as number];
        if (arr.some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
        if (!this.counts.has(key)) this.init(key, arr.length);
        const count = this.counts.get(key)! + 1;
        this.counts.set(key, count);
        const mins = this.mins.get(key)!;
        const maxs = this.maxs.get(key)!;
        const means = this.means.get(key)!;
        const m2s = this.m2s.get(key)!;
        for (let j = 0; j < arr.length; j++) {
          const x = arr[j];
          if (x < mins[j]) mins[j] = x;
          if (x > maxs[j]) maxs[j] = x;
          const delta = x - means[j];
          means[j] += delta / count;
          const delta2 = x - means[j];
          m2s[j] += delta * delta2;
        }
      }
    }
  }

  private init(key: string, n: number): void {
    this.mins.set(key, new Array(n).fill(Infinity));
    this.maxs.set(key, new Array(n).fill(-Infinity));
    this.means.set(key, new Array(n).fill(0));
    this.m2s.set(key, new Array(n).fill(0));
    this.counts.set(key, 0);
  }

  toPerEpisode(resolveKey: (pk: string) => string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const pk of this.counts.keys()) {
      const count = this.counts.get(pk)!;
      out[resolveKey(pk)] = {
        min: this.mins.get(pk),
        max: this.maxs.get(pk),
        mean: this.means.get(pk)!,
        std: this.m2s.get(pk)!.map((m2) => Math.sqrt(m2 / count)),
      };
    }
    return out;
  }
}

function featureKeyMap(info: LeRobotInfo): (pk: string) => string {
  const featureKeys = Object.keys(info.features);
  return (pk: string): string => {
    if (featureKeys.includes(pk)) return pk;
    const lower = pk.toLowerCase();
    return featureKeys.find((fk) => fk.toLowerCase() === lower) ?? pk;
  };
}

// ---- helpers ----

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") out[key] = Number(value);
    else if (Array.isArray(value)) out[key] = value.map((v) => (typeof v === "bigint" ? Number(v) : v));
    else out[key] = value;
  }
  return out;
}
