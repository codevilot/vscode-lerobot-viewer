// Adapter contract for reading a LeRobot dataset off disk.
//
// Implementations must not import `vscode` — keeping them pure Node makes
// them unit-testable and lets the same code run during workspace scanning
// before any webview exists.

import type { LeRobotEpisode, LeRobotInfo, DatasetVersion, TaskInfo } from "../../types";

export interface VideoLocation {
  /** Absolute path on disk to the video file. */
  path: string;
  /**
   * For sharded layouts (v3.0), the half-open frame range inside the shard
   * that belongs to the requested episode.
   */
  shardFrameRange?: [number, number];
  /**
   * Optional user-facing note explaining how the location was determined
   * (e.g. fallback path when shard index could not be resolved).
   */
  note?: string;
}

export interface AdapterContext {
  /** Absolute root of the dataset directory. */
  root: string;
  /** Parsed info.json. */
  info: LeRobotInfo;
}

export interface DatasetAdapter {
  readonly version: DatasetVersion;

  /**
   * Parse `meta/info.json`. Adapters may add version-specific fields to the
   * raw object before returning so callers can introspect later.
   */
  loadInfo(root: string): Promise<LeRobotInfo>;

  /**
   * Return the canonical episode list. Adapters MUST be metadata-driven:
   *   - v2.x: read meta/episodes.jsonl
   *   - v3.0: read meta/episodes/(chunk dirs)/*.parquet boundaries (or jsonl fallback)
   * They must NOT enumerate data/(chunk dirs)/*.parquet filenames as a
   * source of truth — that breaks for sharded layouts and is unreliable.
   */
  loadEpisodes(ctx: AdapterContext): Promise<LeRobotEpisode[]>;

  /**
   * Resolve the video file (and shard frame range) for a given episode and
   * camera feature key. Returns `undefined` when the file cannot be located.
   */
  resolveVideo(
    ctx: AdapterContext,
    episode: LeRobotEpisode,
    videoKey: string,
  ): Promise<VideoLocation | undefined>;

  /**
   * Load distinct task descriptions. Adapters should look at version-native
   * task metadata (v3.0: meta/tasks.parquet, v2.x: meta/tasks.jsonl) and
   * return an empty list rather than throwing if metadata is missing.
   */
  loadTasks(ctx: AdapterContext): Promise<TaskInfo[]>;
}
