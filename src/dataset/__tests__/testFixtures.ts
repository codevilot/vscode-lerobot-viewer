// Test helpers shared by adapter / detector tests. Builds dataset layouts
// inside a fresh tmpdir so each test gets an isolated filesystem.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type Layout = Record<string, string | Buffer>;

export async function makeTempDataset(layout: Layout): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lerobot-test-"));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content as string | Uint8Array);
  }
  return dir;
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export const V21_INFO = JSON.stringify({
  codebase_version: "v2.1",
  robot_type: "so100",
  fps: 30,
  total_episodes: 3,
  total_frames: 540,
  total_videos: 6,
  chunks_size: 1000,
  data_path: "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
  video_path: "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
  features: {
    "observation.images.front": {
      dtype: "video",
      shape: [480, 640, 3],
      names: ["height", "width", "channel"],
    },
    "observation.state": { dtype: "float32", shape: [6] },
    action: { dtype: "float32", shape: [6] },
  },
});

export const V21_EPISODES_JSONL = [
  '{"episode_index": 0, "tasks": ["pick"], "length": 180}',
  '{"episode_index": 1, "tasks": ["pick"], "length": 175}',
  '{"episode_index": 2, "tasks": ["pick"], "length": 185}',
  "",
].join("\n");

export const V30_INFO = JSON.stringify({
  codebase_version: "v3.0",
  robot_type: "aloha",
  fps: 50,
  total_episodes: 4,
  total_frames: 800,
  chunks_size: 1000,
  data_path: "data/chunk-{episode_chunk:03d}/file-{file_index:03d}.parquet",
  video_path: "videos/{video_key}/chunk-{episode_chunk:03d}/file-{file_index:03d}.mp4",
  features: {
    "observation.images.cam_high": { dtype: "video", shape: [480, 640, 3] },
    "observation.state": { dtype: "float32", shape: [14] },
    action: { dtype: "float32", shape: [14] },
  },
});

export const V30_EPISODES_AGGREGATE = JSON.stringify({
  episodes: [
    { episode_index: 0, tasks: ["transfer"], length: 200, "data/chunk_index": 0, "data/file_index": 0, dataset_from_index: 0, dataset_to_index: 200 },
    { episode_index: 1, tasks: ["transfer"], length: 200, "data/chunk_index": 0, "data/file_index": 0, dataset_from_index: 200, dataset_to_index: 400 },
    { episode_index: 2, tasks: ["press"], length: 200, "data/chunk_index": 0, "data/file_index": 1, dataset_from_index: 0, dataset_to_index: 200 },
    { episode_index: 3, tasks: ["press"], length: 200, "data/chunk_index": 0, "data/file_index": 1, dataset_from_index: 200, dataset_to_index: 400 },
  ],
});
