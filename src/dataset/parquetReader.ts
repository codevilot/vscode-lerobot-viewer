// Pure-JS parquet decoding for the per-frame signals LeRobot's official
// visualizers care about: state, action, velocity, effort, environment
// state, reward, done/success/truncated, and per-frame task_index.
//
// hyparquet runs in Node and decodes the columns we ask for without
// needing arrow / pyarrow / a Python helper.

import * as path from "node:path";
import * as vscode from "vscode";
import type { DatasetSnapshot, LeRobotEpisode } from "../types";
import { buildDataPath, exists } from "./adapters/util";
import { ensureSshFile } from "./ssh";
import { log, logError } from "../log";

// Lazy ESM import so this module loads under tsx's CJS pipeline too.
let hyparquetPromise: Promise<typeof import("hyparquet")> | undefined;
function getHyparquet() {
  return (hyparquetPromise ??= import("hyparquet"));
}

/** Cap signal length so the webview stays responsive on long episodes. */
const MAX_SAMPLES = 500;

export interface EpisodeSignals {
  state?: number[][];
  action?: number[][];
  velocity?: number[][];
  effort?: number[][];
  environmentState?: number[][];
  reward?: number[];
  done?: number[];
  success?: number[];
  truncated?: number[];
  taskIndices?: number[];
  /** User-facing note when decoding fell back / was skipped. */
  warning?: string;
}

export async function readEpisodeSignals(
  snapshot: DatasetSnapshot,
  episode: LeRobotEpisode,
): Promise<EpisodeSignals> {
  if (!snapshot.descriptor.root) return {};

  const matrixGroups: Array<{ key: keyof EpisodeSignals; cols: string[] }> = [
    { key: "state", cols: snapshot.stateKeys },
    { key: "action", cols: snapshot.actionKeys },
    { key: "velocity", cols: snapshot.velocityKeys },
    { key: "effort", cols: snapshot.effortKeys },
    { key: "environmentState", cols: snapshot.environmentStateKeys },
  ];
  const scalarColumns = [
    snapshot.rewardKey,
    snapshot.doneKey,
    snapshot.successKey,
    snapshot.truncatedKey,
    snapshot.taskIndexKey,
  ].filter((c): c is string => !!c);

  const allMatrixCols = matrixGroups.flatMap((g) => g.cols);
  if (allMatrixCols.length === 0 && scalarColumns.length === 0) {
    return { warning: "Dataset has no recognized signal features." };
  }

  const dataPath = resolveDataPath(snapshot, episode);
  if (!dataPath) return { warning: "Could not infer parquet path from info.json template." };
  if (snapshot.descriptor.source === "ssh" && !(await exists(dataPath))) {
    const rel = path.relative(snapshot.descriptor.root, dataPath);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `LeRobot · ${path.basename(rel)}` },
        async (progress) =>
          ensureSshFile(snapshot.descriptor, rel, (msg) => progress.report({ message: msg })),
      );
    } catch (err) {
      return { warning: `SSH download failed for ${rel}: ${(err as Error).message}` };
    }
  }
  if (!(await exists(dataPath))) {
    return { warning: `Parquet not found: ${path.relative(snapshot.descriptor.root, dataPath)}` };
  }

  try {
    const { parquetReadObjects, asyncBufferFromFile } = await getHyparquet();
    const buffer = await asyncBufferFromFile(dataPath);
    const filterByEpisode = snapshot.version === "v3.0";
    const requested = [...allMatrixCols, ...scalarColumns];
    if (filterByEpisode) requested.push("episode_index");

    // For v3.0 shards (which pack multiple episodes), only decode the
    // shard rows the adapter says belong to this episode. Without
    // this we'd pay full-shard decode cost for every episode in a
    // 10-episode shard. v2.x stores one episode per file so the
    // range is the whole file.
    const range =
      filterByEpisode && episode.frameRange
        ? { rowStart: episode.frameRange[0], rowEnd: episode.frameRange[1] }
        : undefined;

    const rows = (await parquetReadObjects({
      file: buffer,
      columns: requested,
      ...range,
    })) as Record<string, unknown>[];

    const matching =
      filterByEpisode && !range
        ? rows.filter((r) => toNumber(r.episode_index) === episode.episodeIndex)
        : rows;

    if (matching.length === 0) {
      return {
        warning: `Parquet decoded but no rows match episode ${episode.episodeIndex}${
          filterByEpisode ? " (episode_index column)" : ""
        }.`,
      };
    }

    const result: EpisodeSignals = {};
    for (const group of matrixGroups) {
      if (group.cols.length === 0) continue;
      const matrix = extractMatrix(matching, group.cols);
      if (matrix.length === 0) continue;
      (result as Record<string, unknown>)[group.key] = decimateMatrix(matrix, MAX_SAMPLES);
    }
    if (snapshot.rewardKey) result.reward = decimateScalar(extractScalar(matching, snapshot.rewardKey), MAX_SAMPLES);
    if (snapshot.doneKey) result.done = decimateScalar(extractScalar(matching, snapshot.doneKey), MAX_SAMPLES);
    if (snapshot.successKey) result.success = decimateScalar(extractScalar(matching, snapshot.successKey), MAX_SAMPLES);
    if (snapshot.truncatedKey) result.truncated = decimateScalar(extractScalar(matching, snapshot.truncatedKey), MAX_SAMPLES);
    if (snapshot.taskIndexKey)
      result.taskIndices = decimateScalar(extractScalar(matching, snapshot.taskIndexKey), MAX_SAMPLES);

    log(
      `Decoded parquet ${path.basename(dataPath)}: ${matching.length} rows, ` +
        `state=${result.state?.[0]?.length ?? 0}d, action=${result.action?.[0]?.length ?? 0}d` +
        (result.velocity ? `, velocity=${result.velocity[0]?.length ?? 0}d` : "") +
        (result.effort ? `, effort=${result.effort[0]?.length ?? 0}d` : "") +
        (result.reward ? ", reward=✓" : "") +
        (result.done ? ", done=✓" : "") +
        (result.taskIndices ? ", task_index=✓" : ""),
    );
    return result;
  } catch (err) {
    logError(`reading parquet ${dataPath}`, err);
    return { warning: `Parquet decode failed: ${(err as Error).message}` };
  }
}

function resolveDataPath(snapshot: DatasetSnapshot, episode: LeRobotEpisode): string | undefined {
  const root = snapshot.descriptor.root;
  if (!root) return undefined;
  const filled = buildDataPath({
    template: snapshot.info.dataPath ?? defaultDataTemplate(snapshot.version),
    chunkIndex: pickChunkIndex(snapshot, episode),
    fileIndex: episode.dataShard?.fileIndex ?? 0,
    episodeIndex: episode.episodeIndex,
  });
  return path.join(root, filled);
}

function defaultDataTemplate(version: DatasetSnapshot["version"]): string {
  return version === "v3.0"
    ? "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
    : "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
}

function pickChunkIndex(snapshot: DatasetSnapshot, episode: LeRobotEpisode): number {
  if (episode.dataShard) return episode.dataShard.chunkIndex;
  const chunkSize = snapshot.info.chunksSize ?? 1000;
  return Math.floor(episode.episodeIndex / chunkSize);
}

function extractMatrix(rows: Record<string, unknown>[], columns: string[]): number[][] {
  if (columns.length === 0) return [];
  return rows.map((row) => {
    const out: number[] = [];
    for (const col of columns) {
      const v = row[col];
      if (Array.isArray(v)) {
        for (const x of v) out.push(toNumber(x));
      } else if (v && typeof v === "object" && Symbol.iterator in (v as object)) {
        for (const x of v as Iterable<unknown>) out.push(toNumber(x));
      } else {
        out.push(toNumber(v));
      }
    }
    return out;
  });
}

function extractScalar(rows: Record<string, unknown>[], column: string): number[] {
  return rows.map((row) => {
    const v = row[column];
    if (typeof v === "boolean") return v ? 1 : 0;
    return toNumber(v);
  });
}

function decimateMatrix(matrix: number[][], max: number): number[][] {
  if (matrix.length <= max) return matrix;
  const step = matrix.length / max;
  const out: number[][] = [];
  for (let i = 0; i < max; i++) out.push(matrix[Math.floor(i * step)]);
  return out;
}

function decimateScalar(arr: number[], max: number): number[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === undefined) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}
