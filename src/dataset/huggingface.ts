// Hugging Face metadata fetcher.
//
// We deliberately stay light: only `meta/info.json` and `meta/episodes.jsonl`
// are pulled, cached locally, and treated like a regular dataset root. Video
// frames are fetched on demand by their resolved URLs.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { log, logError } from "../log";
import type { DatasetDescriptor } from "../types";

const HF_RESOLVE_BASE = "https://huggingface.co";

export interface FetchOptions {
  /** Override cache root. Defaults to ~/.cache/lerobot-viewer. */
  cacheDir?: string;
  /** Optional revision (branch / commit / tag). Defaults to "main". */
  revision?: string;
}

export async function ensureHuggingFaceDataset(
  repoId: string,
  options: FetchOptions = {},
): Promise<DatasetDescriptor> {
  const revision = options.revision ?? "main";
  const cacheRoot = options.cacheDir || defaultCacheDir();
  const datasetRoot = path.join(cacheRoot, "huggingface", sanitize(repoId), revision);
  await fs.mkdir(path.join(datasetRoot, "meta"), { recursive: true });

  await fetchTo(`${HF_RESOLVE_BASE}/datasets/${repoId}/resolve/${revision}/meta/info.json`, path.join(datasetRoot, "meta", "info.json"));
  // episodes.jsonl is optional in older datasets — don't hard-fail.
  try {
    await fetchTo(
      `${HF_RESOLVE_BASE}/datasets/${repoId}/resolve/${revision}/meta/episodes.jsonl`,
      path.join(datasetRoot, "meta", "episodes.jsonl"),
    );
  } catch (err) {
    logError(`fetching episodes.jsonl for ${repoId}`, err);
  }

  return {
    id: `hf:${repoId}@${revision}`,
    name: repoId,
    root: datasetRoot,
    repoId,
    source: "huggingface",
  };
}

function defaultCacheDir(): string {
  return path.join(os.homedir(), ".cache", "lerobot-viewer");
}

function sanitize(repoId: string): string {
  return repoId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function fetchTo(url: string, dest: string): Promise<void> {
  log(`HF fetch ${url}`);
  // Node 18+ ships fetch globally.
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Hugging Face fetch failed (${res.status} ${res.statusText}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

export function isValidRepoId(input: string): boolean {
  // Loose validation: namespace/name where each segment is non-empty.
  return /^[\w.-]+\/[\w.-]+$/.test(input);
}

export function pickHuggingFaceCacheDir(): string {
  const configured = vscode.workspace.getConfiguration("lerobotViewer").get<string>("huggingfaceCacheDir") ?? "";
  return configured.trim() || defaultCacheDir();
}
