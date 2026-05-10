// Shared types used by the extension backend.
//
// These mirror the LeRobot v2 dataset format
// (https://huggingface.co/docs/lerobot). We keep the schema permissive on
// purpose: real datasets in the wild contain extra/missing fields, and we
// would rather render a partial view than refuse to load.

export type DatasetSource = "workspace" | "manual" | "huggingface" | "ssh";

/**
 * LeRobot dataset format version. Version controls how episodes, parquet
 * shards, and video files are laid out on disk.
 *
 *   - "v2.0" / "v2.1": one parquet + one video per episode, per camera.
 *   - "v3.0":          parquet/video shards span multiple episodes; episode
 *                      boundaries live in `meta/episodes/*.parquet`.
 *   - "unknown":       version could not be inferred — best-effort inspection.
 */
export type DatasetVersion = "v2.0" | "v2.1" | "v3.0" | "unknown";

export interface FeatureSpec {
  dtype: string;
  shape?: number[];
  names?: string[] | Record<string, string[]>;
  // Video features carry extra metadata in some dataset versions.
  info?: Record<string, unknown>;
}

export interface LeRobotInfo {
  codebaseVersion?: string;
  robotType?: string;
  fps: number;
  totalEpisodes: number;
  totalFrames: number;
  totalTasks?: number;
  totalVideos?: number;
  totalChunks?: number;
  chunksSize?: number;
  /** v3.0 only: number of bytes per data shard. Used by sharded adapters. */
  dataFilesSizeInMb?: number;
  videoFilesSizeInMb?: number;
  splits?: Record<string, string>;
  dataPath?: string;
  videoPath?: string;
  features: Record<string, FeatureSpec>;
  // Keep the raw object around for the metadata panel.
  raw: Record<string, unknown>;
}

export interface ShardLocation {
  chunkIndex: number;
  fileIndex: number;
}

export interface LeRobotEpisode {
  episodeIndex: number;
  tasks: string[];
  length: number;
  /**
   * v3.0 only: half-open frame range [from, to) inside the global dataset
   * timeline. Adapters that don't parse shard boundaries leave this empty.
   */
  frameRange?: [number, number];
  /**
   * v3.0 only: parquet shard containing this episode's tabular data.
   */
  dataShard?: ShardLocation;
  /**
   * v3.0 only: per-camera video shard locations, keyed by feature name
   * (e.g. "observation.image"). Different cameras can live in different
   * shards.
   */
  videoShards?: Record<string, ShardLocation>;
  /**
   * v3.0 only: per-camera timestamp range inside the video shard, in
   * seconds. Used by the player to clip playback to this episode's slice.
   */
  videoRanges?: Record<string, [number, number]>;
}

export interface SshTarget {
  host: string;
  port?: number;
  user?: string;
  /** Identity file resolved from ~/.ssh/config (absolute path). */
  identityFile?: string;
  /** Remote dataset root path (POSIX). */
  remotePath: string;
  /** Original alias from ssh_config, when one was used to connect. */
  alias?: string;
}

export interface DatasetDescriptor {
  /** Stable id used by the tree provider and command args. */
  id: string;
  /** Human readable label. */
  name: string;
  /**
   * Local filesystem root. For SSH-backed datasets this points at the
   * extension-managed cache directory; remote files are downloaded into
   * this tree on demand.
   */
  root?: string;
  /** Hugging Face repo id (e.g. "lerobot/aloha_sim_insertion_human"). */
  repoId?: string;
  /** SSH connection details for remote datasets. */
  ssh?: SshTarget;
  source: DatasetSource;
}

export interface TaskInfo {
  taskIndex: number;
  task: string;
  /** Number of episodes assigned this task, when computable. */
  episodeCount?: number;
}

export interface FeatureStats {
  min?: number[];
  max?: number[];
  mean?: number[];
  std?: number[];
  q01?: number[];
  q99?: number[];
  count?: number;
}

export interface DatasetSnapshot {
  descriptor: DatasetDescriptor;
  info: LeRobotInfo;
  episodes: LeRobotEpisode[];
  /** Camera feature keys, e.g. "observation.images.front". */
  cameraKeys: string[];
  /** State feature keys, e.g. "observation.state". */
  stateKeys: string[];
  /** Action feature keys, e.g. "action". */
  actionKeys: string[];
  velocityKeys: string[];
  effortKeys: string[];
  environmentStateKeys: string[];
  rewardKey?: string;
  doneKey?: string;
  successKey?: string;
  truncatedKey?: string;
  taskIndexKey?: string;
  /** Distinct tasks declared by the dataset, with episode counts when known. */
  tasks: TaskInfo[];
  /** Per-feature dataset-wide statistics from meta/stats.json. */
  stats: Record<string, FeatureStats>;
  /** Splits parsed from info.splits, e.g. {train: [0, 200], val: [200, 250]}. */
  splits: Record<string, [number, number]>;
  /** Detected dataset format version. */
  version: DatasetVersion;
  /** Non-fatal warnings to surface to the user (e.g. version inferred). */
  warnings: string[];
}

export interface EpisodePreviewData {
  dataset: DatasetDescriptor;
  version: DatasetVersion;
  info: LeRobotInfo;
  episode: LeRobotEpisode;
  cameras: Array<{
    key: string;
    /** Webview-safe URI for the underlying video file, when available. */
    videoUri?: string;
    /**
     * For sharded layouts, the frame range inside the shard belonging to
     * this episode. Used by the player to clip playback.
     */
    shardFrameRange?: [number, number];
    /** User-visible note when video resolution required a fallback. */
    note?: string;
  }>;
  /** Per-frame state samples. May be downsampled for the preview. */
  state?: number[][];
  /** Per-frame action samples. May be downsampled for the preview. */
  action?: number[][];
  /** Per-frame velocity samples. */
  velocity?: number[][];
  /** Per-frame torque/effort samples. */
  effort?: number[][];
  /** Per-frame environment state samples (object positions etc.). */
  environmentState?: number[][];
  /** Per-frame scalar reward (RL datasets). */
  reward?: number[];
  /** Per-frame boolean done/success/truncated flags as 0/1 series. */
  done?: number[];
  success?: number[];
  truncated?: number[];
  /** Per-frame task_index for multi-task episodes. */
  taskIndices?: number[];
  stateNames?: string[];
  actionNames?: string[];
  velocityNames?: string[];
  effortNames?: string[];
  environmentStateNames?: string[];
  /** Note shown by the signal graphs (e.g. why decoding was skipped). */
  signalsWarning?: string;
  /** Whether the Rerun integration is enabled in user settings. */
  rerunEnabled: boolean;
  /** Distinct tasks for the entire dataset, surfaced in the metadata panel. */
  tasks: TaskInfo[];
  /**
   * Lightweight summary of all episodes in the dataset (length per index).
   * Used to render the "this episode within the dataset" strip and a
   * length distribution visualization. Indexed by episode index.
   */
  episodeLengths: number[];
  /** Number of episodes in the whole dataset. */
  totalEpisodes: number;
  /** Per-feature dataset-wide statistics. */
  stats: Record<string, FeatureStats>;
  /** Splits, mapping name → [from, to] in episode-index space. */
  splits: Record<string, [number, number]>;
  /** Which split this episode belongs to, when computable. */
  episodeSplit?: string;
}

/**
 * Standalone metadata view payload — what the dedicated "open metadata"
 * webview displays. Does not need any per-episode signals or video URIs.
 */
export interface DatasetMetadataView {
  descriptor: DatasetDescriptor;
  version: DatasetVersion;
  info: LeRobotInfo;
  cameraKeys: string[];
  stateKeys: string[];
  actionKeys: string[];
  velocityKeys: string[];
  effortKeys: string[];
  environmentStateKeys: string[];
  rewardKey?: string;
  doneKey?: string;
  successKey?: string;
  truncatedKey?: string;
  taskIndexKey?: string;
  tasks: TaskInfo[];
  stats: Record<string, FeatureStats>;
  splits: Record<string, [number, number]>;
  episodeLengths: number[];
  warnings: string[];
}
