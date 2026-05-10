import { test, after } from "node:test";
import assert from "node:assert/strict";
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
