import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deleteV2Episodes } from "./deleteEpisode";
import type { DatasetSnapshot } from "../types";
import { cleanup, makeTempDataset } from "./__tests__/testFixtures";

const tempRoots: string[] = [];

after(async () => {
  for (const root of tempRoots) await cleanup(root);
});

test("deleteV2Episodes removes selected metadata and files without compacting indexes", async () => {
  const root = await makeTempDataset({
    "meta/info.json": JSON.stringify({
      codebase_version: "v2.1",
      fps: 30,
      total_episodes: 3,
      total_frames: 18,
      total_videos: 3,
      chunks_size: 1000,
      data_path: "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
      video_path: "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
      features: {
        "observation.images.front": { dtype: "video", shape: [4, 4, 3] },
        action: { dtype: "float32", shape: [2] },
      },
    }),
    "meta/episodes.jsonl": [
      JSON.stringify({ episode_index: 0, tasks: ["pick"], length: 5 }),
      JSON.stringify({ episode_index: 1, tasks: ["place"], length: 6 }),
      JSON.stringify({ episode_index: 2, tasks: ["pick"], length: 7 }),
      "",
    ].join("\n"),
    "meta/episodes_stats.jsonl": [
      JSON.stringify({ episode_index: 0, stats: { action: { count: 5 } } }),
      JSON.stringify({ episode_index: 1, stats: { action: { count: 6 } } }),
      JSON.stringify({ episode_index: 2, stats: { action: { count: 7 } } }),
      "",
    ].join("\n"),
    "data/chunk-000/episode_000000.parquet": Buffer.from("ep0"),
    "data/chunk-000/episode_000001.parquet": Buffer.from("ep1"),
    "data/chunk-000/episode_000002.parquet": Buffer.from("ep2"),
    "videos/chunk-000/observation.images.front/episode_000001.mp4": Buffer.from("video1"),
  });
  tempRoots.push(root);

  const result = await deleteV2Episodes(root, snapshot(root), [1]);

  assert.deepEqual(result.deleted, [1]);
  assert.equal(await pathExists(path.join(root, "data/chunk-000/episode_000001.parquet")), false);
  assert.equal(
    await pathExists(path.join(root, "videos/chunk-000/observation.images.front/episode_000001.mp4")),
    false,
  );
  assert.equal(await pathExists(path.join(root, "data/chunk-000/episode_000002.parquet")), true);

  const episodes = await readJsonl(path.join(root, "meta/episodes.jsonl"));
  assert.deepEqual(episodes.map((episode) => episode.episode_index), [0, 2]);

  const stats = await readJsonl(path.join(root, "meta/episodes_stats.jsonl"));
  assert.deepEqual(stats.map((episode) => episode.episode_index), [0, 2]);

  const info = JSON.parse(await fs.readFile(path.join(root, "meta/info.json"), "utf8"));
  assert.equal(info.total_episodes, 2);
  assert.equal(info.total_frames, 12);
  assert.equal(info.total_videos, 2);
});

test("deleteV2Episodes rejects missing episode indexes before mutating files", async () => {
  const root = await makeTempDataset({
    "meta/info.json": JSON.stringify({
      codebase_version: "v2.1",
      fps: 30,
      total_episodes: 1,
      total_frames: 5,
      chunks_size: 1000,
      features: { action: { dtype: "float32", shape: [2] } },
    }),
    "meta/episodes.jsonl": `${JSON.stringify({ episode_index: 0, tasks: [], length: 5 })}\n`,
    "data/chunk-000/episode_000000.parquet": Buffer.from("ep0"),
  });
  tempRoots.push(root);

  await assert.rejects(() => deleteV2Episodes(root, snapshot(root), [99]), /Episode 99 not found/);
  assert.equal(await pathExists(path.join(root, "data/chunk-000/episode_000000.parquet")), true);
  const episodes = await readJsonl(path.join(root, "meta/episodes.jsonl"));
  assert.deepEqual(episodes.map((episode) => episode.episode_index), [0]);
});

function snapshot(root: string): DatasetSnapshot {
  return {
    descriptor: { id: `local:${root}`, name: path.basename(root), root, source: "manual" },
    version: "v2.1",
    info: {
      fps: 30,
      totalEpisodes: 3,
      totalFrames: 18,
      totalVideos: 3,
      chunksSize: 1000,
      dataPath: "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
      videoPath: "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
      features: {},
      raw: {},
    },
    episodes: [
      { episodeIndex: 0, tasks: ["pick"], length: 5 },
      { episodeIndex: 1, tasks: ["place"], length: 6 },
      { episodeIndex: 2, tasks: ["pick"], length: 7 },
    ],
    cameraKeys: ["observation.images.front"],
    stateKeys: [],
    actionKeys: ["action"],
    velocityKeys: [],
    effortKeys: [],
    environmentStateKeys: [],
    tasks: [],
    stats: {},
    splits: {},
    warnings: [],
  };
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  const text = await fs.readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
