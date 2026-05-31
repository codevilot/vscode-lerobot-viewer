// Tiny HTTP server that serves video files with proper Range support.
// VS Code's webview local server doesn't handle Range requests, causing
// large mp4 files to be fully buffered → OOM crash. This server uses
// fs.createReadStream + range headers for efficient streaming.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const servers = new Map<string, http.Server>();

/**
 * Start a server that serves `filePath` at `http://127.0.0.1:{port}/video`.
 * The server auto-stops after 10 min of inactivity. Returns the URL.
 */
export function serveVideo(filePath: string): string {
  const key = path.resolve(filePath);
  const existing = servers.get(key);
  if (existing) {
    // Already serving this file — return the same URL.
    const addr = existing.address() as { port: number };
    return `http://127.0.0.1:${addr.port}/video`;
  }

  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith("/video")) {
      res.writeHead(404);
      res.end();
      return;
    }
    serveWithRange(req, res, filePath);
  });

  // Auto-shutdown after 10 min idle.
  let timer: NodeJS.Timeout;

  return new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) { reject(new Error("Failed to start video server")); return; }

      timer = setTimeout(() => stopServer(key), 10 * 60 * 1000);
      server.on("request", () => {
        clearTimeout(timer);
        timer = setTimeout(() => stopServer(key), 10 * 60 * 1000);
      });

      servers.set(key, server);
      resolve(`http://127.0.0.1:${addr.port}/video`);
    });
    server.on("error", reject);
  });
}

/**
 * Shut down the server for `filePath` when the panel is disposed.
 */
export function stopServeVideo(filePath: string): void {
  stopServer(path.resolve(filePath));
}

function stopServer(key: string): void {
  const s = servers.get(key);
  if (s) { s.close(); servers.delete(key); }
}

function serveWithRange(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  // No range — serve full file.
  res.writeHead(200, {
    "Content-Length": fileSize,
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
  });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("error", () => { try { res.end(); } catch { /* closed */ } });
  res.on("error", () => { stream.destroy(); });
}
