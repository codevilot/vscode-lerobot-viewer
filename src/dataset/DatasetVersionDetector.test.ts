import { test, after } from "node:test";
import assert from "node:assert/strict";
import { detectDatasetVersion } from "./DatasetVersionDetector";
import {
  cleanup,
  makeTempDataset,
  V21_EPISODES_JSONL,
  V21_INFO,
  V30_INFO,
} from "./__tests__/testFixtures";

const tempRoots: string[] = [];
after(async () => {
  for (const r of tempRoots) await cleanup(r);
});

test("detector: trusts codebase_version field for v2.1", async () => {
  const root = await makeTempDataset({ "meta/info.json": V21_INFO });
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "v2.1");
  assert.match(result.reason, /codebase_version/);
});

test("detector: trusts codebase_version field for v3.0", async () => {
  const root = await makeTempDataset({ "meta/info.json": V30_INFO });
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "v3.0");
});

test("detector: heuristically detects v3.0 from meta/episodes shards", async () => {
  const info = JSON.stringify({ ...JSON.parse(V30_INFO), codebase_version: "" });
  const root = await makeTempDataset({
    "meta/info.json": info,
    "meta/episodes/chunk-000/file-000.parquet": Buffer.alloc(4),
  });
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "v3.0");
  assert.match(result.reason, /shard metadata/);
});

test("detector: heuristically detects v2.1 from per-episode parquet filenames", async () => {
  const info = JSON.stringify({ ...JSON.parse(V21_INFO), codebase_version: "" });
  const root = await makeTempDataset({
    "meta/info.json": info,
    "data/chunk-000/episode_000000.parquet": Buffer.alloc(4),
    "data/chunk-000/episode_000001.parquet": Buffer.alloc(4),
  });
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "v2.1");
  assert.match(result.reason, /episode_/);
});

test("detector: heuristically detects v3.0 from sharded data filenames", async () => {
  const info = JSON.stringify({ ...JSON.parse(V30_INFO), codebase_version: "" });
  const root = await makeTempDataset({
    "meta/info.json": info,
    "data/chunk-000/file-000.parquet": Buffer.alloc(4),
  });
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "v3.0");
  assert.match(result.reason, /file-/);
});

test("detector: returns unknown with warnings for ambiguous layout", async () => {
  const root = await makeTempDataset({
    "meta/info.json": JSON.stringify({ codebase_version: "v9.9", features: {} }),
  });
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "unknown");
  assert.ok(result.warnings.some((w) => w.includes("Unrecognized codebase_version")));
});

test("detector: episodes.jsonl alone implies v2.1", async () => {
  const root = await makeTempDataset({
    "meta/info.json": JSON.stringify({ codebase_version: "", features: {} }),
    "meta/episodes.jsonl": V21_EPISODES_JSONL,
  });
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "v2.1");
});

test("detector: warns when info.json missing but still returns unknown", async () => {
  const root = await makeTempDataset({});
  tempRoots.push(root);
  const result = await detectDatasetVersion(root);
  assert.equal(result.version, "unknown");
  assert.ok(result.warnings.some((w) => w.includes("meta/info.json missing")));
});
