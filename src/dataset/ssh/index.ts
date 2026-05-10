// Public surface of the SSH module. Callers import from "ssh" and never
// need to care about the internal split.

export { parseSshConfig, parseSshConfigText, type SshHostAlias } from "./config";
export { pickRemoteFolder } from "./browser";
export { ensureSshFile, fetchSshDataset, probeRemoteDataset, sshCacheRoot } from "./fetch";
