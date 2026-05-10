// DatasetVersionDetector
//
// Decides which DatasetAdapter to use for a dataset directory.
//
// Priority:
//   1. `meta/info.json` codebase_version field (canonical).
//   2. Layout heuristics:
//        - `meta/episodes/` directory with parquet shards   → v3.0
//        - `data/chunk-XXX/episode_NNNNNN.parquet` files     → v2.x
//        - `data/chunk-XXX/file-NNN.parquet` files           → v3.0
//   3. If still ambiguous: "unknown" with a warning.
//
// Pure Node so it runs both inside the extension host and the test runner.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatasetVersion } from "../types";
import { exists, readJson } from "./adapters/util";

export interface DetectionResult {
  version: DatasetVersion;
  /** Human-readable reason explaining how the version was decided. */
  reason: string;
  /** Non-fatal warnings to surface to the user. */
  warnings: string[];
}

export async function detectDatasetVersion(root: string): Promise<DetectionResult> {
  const warnings: string[] = [];

  // 1. Authoritative: codebase_version in info.json
  const infoPath = path.join(root, "meta", "info.json");
  if (await exists(infoPath)) {
    try {
      const raw = await readJson(infoPath);
      const declared = typeof raw.codebase_version === "string" ? raw.codebase_version : "";
      const normalized = normalizeDeclared(declared);
      if (normalized !== "unknown") {
        return {
          version: normalized,
          reason: `Declared codebase_version="${declared}" in meta/info.json`,
          warnings,
        };
      }
      if (declared) {
        warnings.push(`Unrecognized codebase_version "${declared}"; using layout heuristics.`);
      }
    } catch (err) {
      warnings.push(`Could not parse meta/info.json (${(err as Error).message}); using layout heuristics.`);
    }
  } else {
    warnings.push("meta/info.json missing; relying purely on directory layout heuristics.");
  }

  // 2. Heuristics
  const heuristic = await heuristicDetect(root);
  if (heuristic) {
    return { version: heuristic.version, reason: heuristic.reason, warnings };
  }

  warnings.push("Could not infer LeRobot dataset version; attempting best-effort inspection.");
  return {
    version: "unknown",
    reason: "No version markers found",
    warnings,
  };
}

function normalizeDeclared(declared: string): DatasetVersion {
  const v = declared.trim().toLowerCase();
  if (v === "v3.0" || v.startsWith("v3.")) return "v3.0";
  if (v === "v2.1") return "v2.1";
  if (v === "v2.0" || v.startsWith("v2.")) return "v2.0";
  return "unknown";
}

interface Heuristic {
  version: DatasetVersion;
  reason: string;
}

async function heuristicDetect(root: string): Promise<Heuristic | undefined> {
  // v3.0 marker: meta/episodes/ directory containing parquet files
  if (await dirHasParquet(path.join(root, "meta", "episodes"))) {
    return { version: "v3.0", reason: "Found meta/episodes/*.parquet shard metadata" };
  }

  // Look at first available data chunk and inspect filenames
  const dataDir = path.join(root, "data");
  const firstChunk = await firstSubdirectory(dataDir);
  if (firstChunk) {
    const entries = await safeReaddir(firstChunk);
    const hasV21Files = entries.some((e) => /^episode_\d+\.parquet$/.test(e));
    const hasV30Files = entries.some((e) => /^file-\d+\.parquet$/.test(e));
    if (hasV30Files && !hasV21Files) {
      return { version: "v3.0", reason: `Found sharded data files in ${path.basename(firstChunk)}/file-*.parquet` };
    }
    if (hasV21Files && !hasV30Files) {
      return { version: "v2.1", reason: `Found per-episode files in ${path.basename(firstChunk)}/episode_*.parquet` };
    }
  }

  // episodes.jsonl alone is consistent with v2.x
  if (await exists(path.join(root, "meta", "episodes.jsonl"))) {
    return { version: "v2.1", reason: "Found meta/episodes.jsonl (no v3.0 markers)" };
  }

  return undefined;
}

async function dirHasParquet(dir: string): Promise<boolean> {
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (entry.endsWith(".parquet")) return true;
    // recurse one level for chunk-XXX dirs
    const inner = await safeReaddir(path.join(dir, entry));
    if (inner.some((f) => f.endsWith(".parquet"))) return true;
  }
  return false;
}

async function firstSubdirectory(dir: string): Promise<string | undefined> {
  const entries = await safeReaddir(dir);
  for (const entry of entries.sort()) {
    const full = path.join(dir, entry);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) return full;
    } catch {
      // ignore
    }
  }
  return undefined;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
