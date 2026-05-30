import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { V21Adapter } from "./V21Adapter";
import {
  cleanup,
  makeTempDataset,
  V21_EPISODES_JSONL,
  V21_INFO,
} from "../__tests__/testFixtures";

const tempRoots: string[] = [];
after(async () => {
  for (const r of tempRoots) await cleanup(r);
});

test("V21Adapter: parses info.json into normalized LeRobotInfo", async () => {
  const root = await makeTempDataset({ "meta/info.json": V21_INFO });
  tempRoots.push(root);
  const adapter = new V21Adapter("v2.1");
  const info = await adapter.loadInfo(root);
  assert.equal(info.fps, 30);
  assert.equal(info.totalEpisodes, 3);
  assert.equal(info.codebaseVersion, "v2.1");
  assert.equal(info.features["observation.state"]?.dtype, "float32");
  assert.deepEqual(info.features["observation.state"]?.shape, [6]);
});

test("V21Adapter: reads episodes.jsonl in metadata-driven order", async () => {
  const root = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
  });
  tempRoots.push(root);
  const adapter = new V21Adapter("v2.1");
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  assert.equal(episodes.length, 3);
  assert.deepEqual(
    episodes.map((e) => e.episodeIndex),
    [0, 1, 2],
  );
  assert.equal(episodes[0].length, 180);
  assert.deepEqual(episodes[0].tasks, ["pick"]);
});

test("V21Adapter: synthesizes episodes from info totals when jsonl is missing", async () => {
  const root = await makeTempDataset({ "meta/info.json": V21_INFO });
  tempRoots.push(root);
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  assert.equal(episodes.length, 3);
  // 540 frames / 3 episodes = 180 average
  assert.equal(episodes[0].length, 180);
});

test("V21Adapter: resolves per-episode video file via template", async () => {
  const videoRel = "videos/chunk-000/observation.images.front/episode_000001.mp4";
  const root = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
    [videoRel]: Buffer.alloc(8),
  });
  tempRoots.push(root);
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  const ep1 = episodes.find((e) => e.episodeIndex === 1)!;
  const loc = await adapter.resolveVideo({ root, info }, ep1, "observation.images.front");
  assert.ok(loc, "video should resolve");
  assert.equal(loc!.path, path.join(root, videoRel));
  assert.equal(loc!.shardFrameRange, undefined);
});

test("V21Adapter: returns undefined when video file is missing", async () => {
  const root = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
  });
  tempRoots.push(root);
  const adapter = new V21Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  const loc = await adapter.resolveVideo(
    { root, info },
    episodes[0],
    "observation.images.front",
  );
  assert.equal(loc, undefined);
});

// ---- saveTasks round-trip ----

test("V21Adapter: saveTasks writes and loadTasks reads back", async () => {
  const root = await makeTempDataset({ "meta/info.json": V21_INFO });
  tempRoots.push(root);
  const adapter = new V21Adapter();
  const tasks = [
    { taskIndex: 0, task: "pick up cube" },
    { taskIndex: 1, task: "press button" },
  ];
  await adapter.saveTasks!(root, tasks);

  // Read back via loadTasks.
  const info = await adapter.loadInfo(root);
  const loaded = await adapter.loadTasks({ root, info });
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].taskIndex, 0);
  assert.equal(loaded[0].task, "pick up cube");
  assert.equal(loaded[1].taskIndex, 1);
  assert.equal(loaded[1].task, "press button");

  // Verify on-disk format.
  const raw = await fs.readFile(path.join(root, "meta", "tasks.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 2);
  const parsed0 = JSON.parse(lines[0]);
  assert.equal(parsed0.task_index, 0);
  assert.equal(parsed0.task, "pick up cube");
});

test("V21Adapter: saveTasks overwrites existing tasks.jsonl", async () => {
  const existingTasks = [
    JSON.stringify({ task_index: 0, task: "old task" }),
    "",
  ].join("\n");
  const root = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/tasks.jsonl": existingTasks,
  });
  tempRoots.push(root);
  const adapter = new V21Adapter();

  await adapter.saveTasks!(root, [{ taskIndex: 5, task: "new task" }]);
  const info = await adapter.loadInfo(root);
  const loaded = await adapter.loadTasks({ root, info });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].taskIndex, 5);
  assert.equal(loaded[0].task, "new task");
});

test("V21Adapter: readEpisodeRecords returns raw records", async () => {
  const root = await makeTempDataset({
    "meta/info.json": V21_INFO,
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
  });
  tempRoots.push(root);
  const adapter = new V21Adapter();
  const records = await adapter.readEpisodeRecords!(root);
  assert.ok(records);
  assert.equal(records!.length, 3);
  assert.equal(records![0].episode_index, 0);
  assert.deepEqual(records![0].tasks, ["pick"]);
});

test("V21Adapter: saveEpisodeRecords writes and readEpisodeRecords reads back", async () => {
  const root = await makeTempDataset({ "meta/info.json": V21_INFO });
  tempRoots.push(root);
  const adapter = new V21Adapter();

  const records = [
    { episode_index: 0, tasks: ["grasp"], length: 100 },
    { episode_index: 1, tasks: ["grasp", "lift"], length: 120 },
  ];
  await adapter.saveEpisodeRecords!(root, records);

  const loaded = await adapter.readEpisodeRecords!(root);
  assert.ok(loaded);
  assert.equal(loaded!.length, 2);
  assert.deepEqual(loaded![1].tasks, ["grasp", "lift"]);
});
