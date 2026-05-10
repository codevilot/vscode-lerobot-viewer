// Pure parser for ~/.ssh/config. No I/O outside the readFile entry point;
// no UI dependencies. Returns concrete (non-wildcard) host aliases only.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

export interface SshHostAlias {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export async function parseSshConfig(): Promise<SshHostAlias[]> {
  const file = nodePath.join(os.homedir(), ".ssh", "config");
  try {
    return parseSshConfigText(await fs.readFile(file, "utf8"));
  } catch {
    return [];
  }
}

export function parseSshConfigText(text: string): SshHostAlias[] {
  const out: SshHostAlias[] = [];
  let current: Partial<SshHostAlias> | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      flush(current, out);
      current = { alias: value };
    } else if (current) {
      switch (key) {
        case "hostname":
          current.hostName = value;
          break;
        case "user":
          current.user = value;
          break;
        case "port":
          current.port = parseInt(value, 10);
          break;
        case "identityfile":
          current.identityFile = expandHome(value);
          break;
      }
    }
  }
  flush(current, out);
  return out.filter((h) => !h.alias.includes("*") && !h.alias.includes("?"));
}

function flush(current: Partial<SshHostAlias> | null, out: SshHostAlias[]): void {
  if (current?.alias && current.hostName) out.push(current as SshHostAlias);
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return nodePath.join(os.homedir(), p.slice(2));
  return p;
}

/** Probe common default key locations in priority order. */
export async function findDefaultIdentityFile(): Promise<string | undefined> {
  const candidates = ["id_ed25519", "id_ecdsa", "id_rsa"];
  for (const name of candidates) {
    const p = nodePath.join(os.homedir(), ".ssh", name);
    try {
      await fs.access(p);
      return p;
    } catch {
      // skip
    }
  }
  return undefined;
}
