// SSH/SFTP connection + auth retry. Talks to vscode for password prompts
// but holds no domain state — callers pass an SshTarget and get a
// connected SftpClient (or a friendly error).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import SftpClient from "ssh2-sftp-client";
import * as vscode from "vscode";
import { log } from "../../log";
import type { SshTarget } from "../../types";
import { findDefaultIdentityFile } from "./config";

interface ConnectOptions extends SshTarget {
  /** Optional passphrase or password from a prior prompt. */
  password?: string;
}

/**
 * Run `fn` with a freshly connected SFTP client; always disconnects.
 * Auth retries (up to 3 passphrase / password attempts) live one layer
 * below this — by the time we're inside `fn`, we have a usable client.
 */
export async function withSftp<T>(
  target: SshTarget,
  fn: (sftp: SftpClient) => Promise<T>,
): Promise<T> {
  let sftp: SftpClient | undefined;
  try {
    sftp = await connectWithRetry(target);
    return await fn(sftp);
  } finally {
    try {
      await sftp?.end();
    } catch {
      // ignore disconnect errors
    }
  }
}

/**
 * Connect with up to three credential attempts. After each failure we
 * prompt the user for a password or passphrase (depending on what looks
 * to be the issue). On exhaustion we throw a friendly diagnostic that
 * tells them how to use ssh-agent.
 */
export async function connectWithRetry(target: SshTarget): Promise<SftpClient> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const password =
        attempt === 0 ? undefined : await promptForPassword(target, attempt, lastErr);
      if (attempt > 0 && !password) throw lastErr ?? new Error("Cancelled");
      return await connect(password ? { ...target, password } : target);
    } catch (err) {
      lastErr = err as Error;
      if (!isAuthError(lastErr.message ?? "")) throw lastErr;
    }
  }
  throw new Error(buildAuthFailureMessage(target, lastErr));
}

function isAuthError(message: string): boolean {
  return /passphrase|password|authentication|All configured authentication methods failed|integrity check failed/i.test(
    message,
  );
}

async function connect(opts: ConnectOptions): Promise<SftpClient> {
  const sftp = new SftpClient();
  const cfg: Record<string, unknown> = {
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.user ?? os.userInfo().username,
    readyTimeout: 15_000,
    // tryKeyboard lets PAM/keyboard-interactive servers (where
    // PasswordAuthentication is wrapped in challenge-response) still
    // accept our password.
    tryKeyboard: true,
  };

  // Populate every available auth channel; ssh2 will try them in order:
  // publickey (agent → privateKey) → password → keyboard-interactive.
  if (process.env.SSH_AUTH_SOCK) {
    cfg.agent = process.env.SSH_AUTH_SOCK;
  }

  const keyPath = opts.identityFile ?? (await findDefaultIdentityFile());
  if (keyPath) {
    try {
      const buf = await fs.readFile(keyPath);
      const parsed = parsePrivateKeyBuffer(buf, opts.password);
      if (!(parsed instanceof Error)) {
        cfg.privateKey = parsed;
      } else if (!/encrypted|passphrase/i.test(parsed.message)) {
        log(`Identity file ${keyPath} could not be parsed: ${parsed.message}`);
      }
    } catch (err) {
      log(`SSH identity file unreadable (${keyPath}): ${(err as Error).message}`);
    }
  }

  if (opts.password) cfg.password = opts.password;

  // Keyboard-interactive needs a listener installed on the underlying
  // ssh2 Client BEFORE connect runs.
  if (opts.password) {
    const inner = (sftp as unknown as { client: { on: (e: string, h: unknown) => void } }).client;
    inner.on(
      "keyboard-interactive",
      (
        _name: string,
        _instructions: string,
        _lang: string,
        prompts: Array<{ prompt: string; echo: boolean }>,
        finish: (answers: string[]) => void,
      ) => {
        finish(prompts.map(() => opts.password!));
      },
    );
  }

  await sftp.connect(cfg);
  return sftp;
}

function parsePrivateKeyBuffer(buf: Buffer, passphrase?: string): unknown {
  // Lazy require so this module still loads when ssh2 isn't bundled.
  const ssh2 = require("ssh2") as {
    utils: { parseKey: (buf: Buffer, passphrase?: string) => unknown };
  };
  return passphrase ? ssh2.utils.parseKey(buf, passphrase) : ssh2.utils.parseKey(buf);
}

async function promptForPassword(
  target: SshTarget,
  attempt: number,
  lastErr?: Error,
): Promise<string | undefined> {
  const isIntegrityIssue = lastErr && /integrity check failed/i.test(lastErr.message);
  const lead = isIntegrityIssue
    ? "Passphrase did not unlock the key (or ssh2 cannot decrypt this key format)."
    : attempt === 1
      ? "Enter the password (or private-key passphrase)."
      : "That didn't work — try again.";
  return vscode.window.showInputBox({
    password: true,
    title: `SSH credentials for ${target.user ? `${target.user}@` : ""}${target.host}`,
    prompt: `${lead}${attempt > 1 ? `  (attempt ${attempt} of 3)` : ""}  Tip: ssh-agent is used automatically when $SSH_AUTH_SOCK is set.`,
    ignoreFocusOut: true,
  });
}

function buildAuthFailureMessage(target: SshTarget, lastErr?: Error): string {
  const msg = lastErr?.message ?? "Authentication failed";
  const tips: string[] = [];

  if (/All configured authentication methods failed/i.test(msg)) {
    tips.push(
      "The server rejected every authentication method we tried. Common causes:",
      "  • Server has PasswordAuthentication=no (most cloud/dev servers default to this)",
      "  • Your public key isn't in the server's ~/.ssh/authorized_keys",
      "  • The wrong username (try the SSH-config alias instead of plain host)",
    );
  } else if (/integrity check failed|bad passphrase|Cannot parse privateKey/i.test(msg)) {
    tips.push(
      "ssh2's parser rejected your encrypted private key. The passphrase may be correct,",
      "but the key format isn't fully supported by the JS implementation.",
    );
  }

  tips.push(
    "",
    "Recommended fix — load your key into ssh-agent once:",
    `  ssh-add ${target.identityFile ?? "~/.ssh/id_ed25519"}`,
    "  (then retry — the extension uses $SSH_AUTH_SOCK automatically)",
    "",
    "If this VS Code window doesn't see your agent (echo $SSH_AUTH_SOCK in terminal),",
    "launch VS Code from a terminal where the agent is set, or add the key to macOS keychain:",
    "  ssh-add --apple-use-keychain <key>",
  );

  return `${msg}\n\n${tips.join("\n")}`;
}
