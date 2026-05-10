import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("LeRobot Viewer");
  }
  return channel;
}

export function log(message: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  const formatted = args.length === 0 ? message : `${message} ${args.map((a) => safeStringify(a)).join(" ")}`;
  getLogger().appendLine(`[${ts}] ${formatted}`);
}

export function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : safeStringify(err);
  log(`ERROR ${message}: ${detail}`);
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
