import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { V30Adapter } from "./V30Adapter";
import {
  cleanup,
  makeTempDataset,
  V30_EPISODES_AGGREGATE,
  V30_INFO,
} from "../__tests__/testFixtures";

const tempRoots: string[] = [];
after(async () => {
  for (const r of tempRoots) await cleanup(r);
});

test("V30Adapter: parses v3.0 info.json", async () => {
  const root = await makeTempDataset({ "meta/info.json": V30_INFO });
  tempRoots.push(root);
  const adapter = new V30Adapter();
  const info = await adapter.loadInfo(root);
  assert.equal(info.codebaseVersion, "v3.0");
  assert.equal(info.fps, 50);
  assert.equal(info.totalEpisodes, 4);
});

test("V30Adapter: reads aggregate episodes_metadata.json with shard boundaries", async () => {
  const root = await makeTempDataset({
    "meta/info.json": V30_INFO,
    "meta/episodes/episodes_metadata.json": V30_EPISODES_AGGREGATE,
  });
  tempRoots.push(root);
  const adapter = new V30Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  assert.equal(episodes.length, 4);
  assert.deepEqual(episodes[1].frameRange, [200, 400]);
  assert.deepEqual(episodes[1].dataShard, { chunkIndex: 0, fileIndex: 0 });
  assert.deepEqual(episodes[2].dataShard, { chunkIndex: 0, fileIndex: 1 });
  assert.equal(adapter.warnings.length, 0);
});

test("V30Adapter: degrades to synthesized episodes + warning when parquet shards are unreadable", async () => {
  const root = await makeTempDataset({
    "meta/info.json": V30_INFO,
    // Bogus parquet content — hyparquet should reject it and we should
    // fall through to synthesized episodes with a warning.
    "meta/episodes/chunk-000/file-000.parquet": Buffer.from("not-a-real-parquet"),
  });
  tempRoots.push(root);
  const adapter = new V30Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  assert.equal(episodes.length, 4);
  assert.equal(episodes[0].frameRange, undefined);
  assert.ok(
    adapter.warnings.some((w) => w.toLowerCase().includes("parquet")),
    "expected a parquet-related warning",
  );
});

test("V30Adapter: prefers transitional episodes.jsonl when present", async () => {
  const root = await makeTempDataset({
    "meta/info.json": V30_INFO,
    "meta/episodes.jsonl":
      '{"episode_index": 0, "tasks": ["t"], "length": 200, "data/chunk_index": 0, "data/file_index": 7, "dataset_from_index": 0, "dataset_to_index": 200}\n',
  });
  tempRoots.push(root);
  const adapter = new V30Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  assert.equal(episodes.length, 1);
  assert.deepEqual(episodes[0].dataShard, { chunkIndex: 0, fileIndex: 7 });
  assert.deepEqual(episodes[0].frameRange, [0, 200]);
});

test("V30Adapter: resolves shared video shard with frame range when known", async () => {
  // Episode 2's data shard is file-001 (per V30_EPISODES_AGGREGATE). The
  // aggregate JSON doesn't carry per-video shard info, so the adapter falls
  // back to the data shard and surfaces a soft note — that's the expected
  // graceful-degradation path.
  const videoRel = "videos/observation.images.cam_high/chunk-000/file-001.mp4";
  const root = await makeTempDataset({
    "meta/info.json": V30_INFO,
    "meta/episodes/episodes_metadata.json": V30_EPISODES_AGGREGATE,
    [videoRel]: Buffer.alloc(8),
  });
  tempRoots.push(root);
  const adapter = new V30Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  const ep2 = episodes.find((e) => e.episodeIndex === 2)!;
  const loc = await adapter.resolveVideo({ root, info }, ep2, "observation.images.cam_high");
  assert.ok(loc, "shared shard video should resolve");
  assert.equal(loc!.path, path.join(root, videoRel));
  assert.deepEqual(loc!.shardFrameRange, [0, 200]);
  assert.match(loc!.note ?? "", /using data shard/);
});

test("V30Adapter: uses video timestamp range instead of data frame range for shared video", async () => {
  const videoRel = "videos/observation.images.cam_high/chunk-000/file-000.mp4";
  const root = await makeTempDataset({
    "meta/info.json": V30_INFO,
    [videoRel]: Buffer.alloc(8),
  });
  tempRoots.push(root);
  const adapter = new V30Adapter();
  const info = await adapter.loadInfo(root);
  const loc = await adapter.resolveVideo(
    { root, info },
    {
      episodeIndex: 7,
      tasks: ["inspect"],
      length: 100,
      frameRange: [1000, 1100],
      videoShards: {
        "observation.images.cam_high": { chunkIndex: 0, fileIndex: 0 },
      },
      videoRanges: {
        "observation.images.cam_high": [1, 3],
      },
    },
    "observation.images.cam_high",
  );
  assert.ok(loc, "shared shard video should resolve");
  assert.equal(loc!.path, path.join(root, videoRel));
  assert.deepEqual(loc!.shardFrameRange, [50, 150]);
});

test("V30Adapter: falls back to file-000 with note when shard index unknown", async () => {
  const videoRel = "videos/observation.images.cam_high/chunk-000/file-000.mp4";
  const root = await makeTempDataset({
    "meta/info.json": V30_INFO,
    [videoRel]: Buffer.alloc(8),
  });
  tempRoots.push(root);
  const adapter = new V30Adapter();
  const info = await adapter.loadInfo(root);
  const episodes = await adapter.loadEpisodes({ root, info });
  const loc = await adapter.resolveVideo({ root, info }, episodes[0], "observation.images.cam_high");
  assert.ok(loc);
  assert.equal(loc!.path, path.join(root, videoRel));
  assert.match(loc!.note ?? "", /file-000/);
});
