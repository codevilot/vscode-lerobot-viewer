// Public surface of the SSH module. Callers import from "ssh" and never
// need to care about the internal split.

export { parseSshConfig, parseSshConfigText, type SshHostAlias } from "./config";
export { pickRemoteFolder } from "./browser";
export {
  ensureSshFile,
  fetchSshDataset,
  probeRemoteDataset,
  sshCacheDir,
  sshCacheRoot,
  sshDatasetId,
  SSH_CACHE_LAST_ACCESS,
  type ProbeResult,
} from "./fetch";
export { findRemoteDatasets, type ScanProgress } from "./scan";
export {
  setPinnedTargets,
  disposeSshPool,
  getSshConnectionState,
  onSshPoolChange,
  type SshConnectionState,
} from "./pool";
