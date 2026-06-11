// Recursively copy a LeRobot dataset directory. Videos are skipped by
// default (they're large and not modified by dimension editing); if the
// caller wants videos, they should re-run v3→v2.1 conversion afterwards.

import * as fs from "node:fs/promises";
import * as path from "node:path";

// Nothing skipped — dimension editing needs videos preserved.
const SKIP_DIRS = new Set<string>();

export async function copyDataset(
  srcRoot: string,
  dstRoot: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  await fs.mkdir(dstRoot, { recursive: true });
  await copyDir(srcRoot, dstRoot, "", onProgress);
}

async function copyDir(
  srcRoot: string,
  dstRoot: string,
  rel: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  const srcDir = rel ? path.join(srcRoot, rel) : srcRoot;

  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await fs.mkdir(path.join(dstRoot, childRel), { recursive: true });
      await copyDir(srcRoot, dstRoot, childRel, onProgress);
    } else if (e.isFile()) {
      onProgress(childRel);
      await fs.cp(
        path.join(srcRoot, childRel),
        path.join(dstRoot, childRel),
      );
    }
  }
}
