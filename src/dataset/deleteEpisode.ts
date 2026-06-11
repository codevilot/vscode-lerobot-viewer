import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatasetSnapshot, LeRobotEpisode } from "../types";
import { buildDataPath, buildVideoPath, exists, readJson, readJsonlIfExists, writeJsonl } from "./adapters/util";

export interface DeleteEpisodesResult {
  deleted: number[];
  deletedFiles: string[];
  missingFiles: string[];
}

export async function deleteV2Episodes(
  root: string,
  snapshot: DatasetSnapshot,
  episodeIndices: readonly number[],
): Promise<DeleteEpisodesResult> {
  if (snapshot.version !== "v2.0" && snapshot.version !== "v2.1") {
    throw new Error("Episode deletion is currently supported only for LeRobot v2.x datasets.");
  }

  const deleteSet = new Set(episodeIndices);
  if (deleteSet.size === 0) {
    return { deleted: [], deletedFiles: [], missingFiles: [] };
  }

  const episodesPath = path.join(root, "meta", "episodes.jsonl");
  const records = await readJsonlIfExists(episodesPath);
  if (!records) {
    throw new Error("Could not delete episodes: meta/episodes.jsonl is missing.");
  }

  const present = new Set(
    records
      .map((record) => numberField(record.episode_index ?? record.episodeIndex))
      .filter((idx): idx is number => idx !== undefined),
  );
  const missing = [...deleteSet].filter((idx) => !present.has(idx));
  if (missing.length > 0) {
    throw new Error(`Episode ${missing.join(", ")} not found in meta/episodes.jsonl.`);
  }

  const remainingRecords = records.filter((record) => {
    const idx = numberField(record.episode_index ?? record.episodeIndex);
    return idx === undefined || !deleteSet.has(idx);
  });

  await writeJsonlAtomic(episodesPath, remainingRecords);
  await updateEpisodesStats(root, deleteSet);
  await updateInfoTotals(root, remainingRecords, snapshot.cameraKeys.length);

  const fileResult = await removeEpisodeFiles(root, snapshot, deleteSet);
  return {
    deleted: [...deleteSet].sort((a, b) => a - b),
    deletedFiles: fileResult.deletedFiles,
    missingFiles: fileResult.missingFiles,
  };
}

async function updateEpisodesStats(root: string, deleteSet: Set<number>): Promise<void> {
  const statsPath = path.join(root, "meta", "episodes_stats.jsonl");
  const records = await readJsonlIfExists(statsPath);
  if (!records) return;
  const remaining = records.filter((record) => {
    const idx = numberField(record.episode_index ?? record.episodeIndex);
    return idx === undefined || !deleteSet.has(idx);
  });
  await writeJsonlAtomic(statsPath, remaining);
}

async function updateInfoTotals(
  root: string,
  episodeRecords: Record<string, unknown>[],
  cameraCount: number,
): Promise<void> {
  const infoPath = path.join(root, "meta", "info.json");
  const raw = await readJson(infoPath);
  raw.total_episodes = episodeRecords.length;
  raw.total_frames = episodeRecords.reduce((sum, record) => {
    const length = numberField(record.length);
    return sum + (length ?? 0);
  }, 0);
  if (typeof raw.total_videos === "number") {
    raw.total_videos = episodeRecords.length * cameraCount;
  }
  await writeJsonAtomic(infoPath, raw);
}

async function removeEpisodeFiles(
  root: string,
  snapshot: DatasetSnapshot,
  deleteSet: Set<number>,
): Promise<{ deletedFiles: string[]; missingFiles: string[] }> {
  const deletedFiles: string[] = [];
  const missingFiles: string[] = [];
  for (const episode of snapshot.episodes) {
    if (!deleteSet.has(episode.episodeIndex)) continue;
    for (const file of episodeFiles(root, snapshot, episode)) {
      if (!(await exists(file))) {
        missingFiles.push(file);
        continue;
      }
      await fs.rm(file, { force: true });
      deletedFiles.push(file);
    }
  }
  return { deletedFiles, missingFiles };
}

function episodeFiles(root: string, snapshot: DatasetSnapshot, episode: LeRobotEpisode): string[] {
  const chunkSize = snapshot.info.chunksSize ?? 1000;
  const chunkIndex = Math.floor(episode.episodeIndex / chunkSize);
  const dataTemplate = snapshot.info.dataPath ?? "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
  const videoTemplate = snapshot.info.videoPath ?? "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";
  const files = [
    path.join(
      root,
      buildDataPath({
        template: dataTemplate,
        chunkIndex,
        fileIndex: 0,
        episodeIndex: episode.episodeIndex,
      }),
    ),
  ];

  for (const videoKey of snapshot.cameraKeys) {
    files.push(
      path.join(
        root,
        buildVideoPath({
          template: videoTemplate,
          chunkIndex,
          fileIndex: 0,
          episodeIndex: episode.episodeIndex,
          videoKey,
        }),
      ),
    );
  }

  return files;
}

async function writeJsonlAtomic(file: string, records: Record<string, unknown>[]): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeJsonl(tmp, records);
  await fs.rename(tmp, file);
}

async function writeJsonAtomic(file: string, value: Record<string, unknown>): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
