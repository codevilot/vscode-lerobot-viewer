import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { mergeDatasets } from "./mergeDataset";
import { V21Adapter } from "./adapters/V21Adapter";
import { classifyFeatures } from "./adapters/util";
import type { DatasetSnapshot } from "../types";
import {
  cleanup,
  makeTempDataset,
  V21_INFO,
  V21_EPISODES_JSONL,
} from "./__tests__/testFixtures";

const tempRoots: string[] = [];
after(async () => {
  for (const r of tempRoots) await cleanup(r);
});

/** Build a DatasetSnapshot using only the V21Adapter (no vscode imports). */
async function buildSnapshot(root: string, id: string, name: string): Promise<DatasetSnapshot> {
  const adapter = new V21Adapter("v2.1");
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  const tasks = await adapter.loadTasks({ root, info });
  const classification = classifyFeatures(info.features);

  return {
    descriptor: { id, name, root, source: "manual" },
    info,
    episodes,
    cameraKeys: classification.cameraKeys,
    stateKeys: classification.stateKeys,
    actionKeys: classification.actionKeys,
    velocityKeys: classification.velocityKeys,
    effortKeys: classification.effortKeys,
    environmentStateKeys: classification.environmentStateKeys,
    rewardKey: classification.rewardKey,
    doneKey: classification.doneKey,
    successKey: classification.successKey,
    truncatedKey: classification.truncatedKey,
    taskIndexKey: classification.taskIndexKey,
    tasks,
    stats: {},
    splits: {},
    version: "v2.1" as const,
    warnings: [],
  };
}

test("mergeDatasets: merges two v2.1 datasets with correct structure", async () => {
  // Source 1: 3 episodes (indices 0, 1, 2), task "pick"
  const s1 = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
    "meta/tasks.jsonl": [
      JSON.stringify({ task_index: 0, task: "pick" }),
      "",
    ].join("\n"),
    "data/chunk-000/episode_000000.parquet": Buffer.alloc(32),
    "data/chunk-000/episode_000001.parquet": Buffer.alloc(32),
    "data/chunk-000/episode_000002.parquet": Buffer.alloc(32),
  });
  tempRoots.push(s1);

  // Source 2: 2 episodes (indices 0, 1), task "place"
  const V21_INFO2 = JSON.stringify({
    ...JSON.parse(V21_INFO),
    total_episodes: 2,
    total_frames: 360,
    total_videos: 4,
  });
  const s2 = await makeTempDataset({
    "meta/info.json": V21_INFO2,
    "meta/episodes.jsonl": [
      JSON.stringify({ episode_index: 0, tasks: ["place"], length: 180 }),
      JSON.stringify({ episode_index: 1, tasks: ["place"], length: 180 }),
      "",
    ].join("\n"),
    "meta/tasks.jsonl": [
      JSON.stringify({ task_index: 0, task: "place" }),
      "",
    ].join("\n"),
    "data/chunk-000/episode_000000.parquet": Buffer.alloc(32),
    "data/chunk-000/episode_000001.parquet": Buffer.alloc(32),
  });
  tempRoots.push(s2);

  const snap1 = await buildSnapshot(s1, "test:s1", "source1");
  const snap2 = await buildSnapshot(s2, "test:s2", "source2");

  // Create target dir.
  const target = await fs.mkdtemp(path.join(s1, "..", "merged-"));
  tempRoots.push(target);

  const progress: Array<{ done: number; total: number }> = [];
  const result = await mergeDatasets([snap1, snap2], target, (p) =>
    progress.push({ done: p.done, total: p.total }),
  );

  // Verify result totals.
  assert.equal(result.totalEpisodes, 5);
  assert.equal(result.totalFrames, 900); // 540 + 360
  assert.equal(result.totalTasks, 2);

  // Verify info.json.
  const info = JSON.parse(
    await fs.readFile(path.join(target, "meta", "info.json"), "utf8"),
  );
  assert.equal(info.total_episodes, 5);
  assert.equal(info.total_frames, 900);
  assert.equal(info.total_tasks, 2);

  // Verify episodes.jsonl.
  const epsText = await fs.readFile(path.join(target, "meta", "episodes.jsonl"), "utf8");
  const eps = epsText
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  assert.equal(eps.length, 5);
  assert.deepEqual(
    eps.map((e: Record<string, unknown>) => e.episode_index),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(eps[0].tasks, ["pick"]);
  assert.deepEqual(eps[3].tasks, ["place"]);

  // Verify tasks.jsonl.
  const tasksText = await fs.readFile(path.join(target, "meta", "tasks.jsonl"), "utf8");
  const tasks = tasksText
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  assert.equal(tasks.length, 2);
  const taskNames = tasks.map((t: Record<string, unknown>) => t.task).sort();
  assert.deepEqual(taskNames, ["pick", "place"]);

  // Verify parquet files exist at new indices.
  for (let i = 0; i < 5; i++) {
    const chunk = String(Math.floor(i / 1000)).padStart(3, "0");
    const ep = String(i).padStart(6, "0");
    const p = path.join(target, "data", `chunk-${chunk}`, `episode_${ep}.parquet`);
    assert.ok(await fs.stat(p).then(() => true, () => false), `parquet for ep ${i} should exist`);
  }

  // Verify progress was reported.
  assert.ok(progress.length >= 5, "progress should be reported for each episode");
});

test("mergeDatasets: deduplicates tasks with same name across sources", async () => {
  const s1 = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
    "meta/tasks.jsonl": [
      JSON.stringify({ task_index: 0, task: "grasp" }),
      "",
    ].join("\n"),
    "data/chunk-000/episode_000000.parquet": Buffer.alloc(16),
    "data/chunk-000/episode_000001.parquet": Buffer.alloc(16),
    "data/chunk-000/episode_000002.parquet": Buffer.alloc(16),
  });
  tempRoots.push(s1);

  const info2 = JSON.stringify({ ...JSON.parse(V21_INFO), total_episodes: 2, total_frames: 360 });
  const s2 = await makeTempDataset({
    "meta/info.json": info2,
    "meta/episodes.jsonl": [
      JSON.stringify({ episode_index: 0, tasks: ["grasp"], length: 180 }),
      JSON.stringify({ episode_index: 1, tasks: ["lift"], length: 180 }),
      "",
    ].join("\n"),
    "meta/tasks.jsonl": [
      JSON.stringify({ task_index: 0, task: "grasp" }),
      JSON.stringify({ task_index: 1, task: "lift" }),
      "",
    ].join("\n"),
    "data/chunk-000/episode_000000.parquet": Buffer.alloc(16),
    "data/chunk-000/episode_000001.parquet": Buffer.alloc(16),
  });
  tempRoots.push(s2);

  const snap1 = await buildSnapshot(s1, "test:d1", "d1");
  const snap2 = await buildSnapshot(s2, "test:d2", "d2");

  const target = await fs.mkdtemp(path.join(s1, "..", "merged-"));
  tempRoots.push(target);

  const result = await mergeDatasets([snap1, snap2], target, () => {});

  assert.equal(result.totalTasks, 2);
  const tasksText = await fs.readFile(path.join(target, "meta", "tasks.jsonl"), "utf8");
  const tasks = tasksText
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  assert.equal(tasks.length, 2);
  const names = tasks.map((t: Record<string, unknown>) => t.task).sort();
  assert.deepEqual(names, ["grasp", "lift"]);
});

test("mergeDatasets: rejects fewer than 2 datasets", async () => {
  await assert.rejects(
    () => mergeDatasets([], "/tmp/ignored", () => {}),
    /At least 2/,
  );
});

test("mergeDatasets: rejects incompatible fps", async () => {
  const s1 = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
    "data/chunk-000/episode_000000.parquet": Buffer.alloc(16),
    "data/chunk-000/episode_000001.parquet": Buffer.alloc(16),
    "data/chunk-000/episode_000002.parquet": Buffer.alloc(16),
  });
  tempRoots.push(s1);

  const info2 = JSON.stringify({ ...JSON.parse(V21_INFO), fps: 60 });
  const s2 = await makeTempDataset({
    "meta/info.json": info2,
    "meta/episodes.jsonl": [
      JSON.stringify({ episode_index: 0, tasks: [], length: 100 }),
      "",
    ].join("\n"),
    "data/chunk-000/episode_000000.parquet": Buffer.alloc(16),
  });
  tempRoots.push(s2);

  const snap1 = await buildSnapshot(s1, "test:f1", "f1");
  const snap2 = await buildSnapshot(s2, "test:f2", "f2");

  await assert.rejects(
    () => mergeDatasets([snap1, snap2], "/tmp/ignored", () => {}),
    /FPS mismatch/,
  );
});
