// Tiny HTTP server that serves video files with Range support. VS Code's
// webview local server may buffer large mp4 files eagerly; this keeps large
// previews streamable without loading the entire file into memory.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const servers = new Map<string, http.Server>();

export function serveVideo(filePath: string): Promise<string> {
  const key = path.resolve(filePath);
  const existing = servers.get(key);
  if (existing) {
    const addr = existing.address() as { port: number } | null;
    if (addr) return Promise.resolve(`http://127.0.0.1:${addr.port}/video`);
  }

  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith("/video")) {
      res.writeHead(404);
      res.end();
      return;
    }
    serveWithRange(req, res, filePath);
  });

  let timer: NodeJS.Timeout;
  return new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) {
        reject(new Error("Failed to start video server"));
        return;
      }

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

export function stopServeVideo(filePath: string): void {
  stopServer(path.resolve(filePath));
}

function stopServer(key: string): void {
  const server = servers.get(key);
  if (!server) return;
  server.close();
  servers.delete(key);
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
      if (start >= fileSize || end >= fileSize || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    "Content-Length": fileSize,
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
  });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("error", () => {
    try {
      res.end();
    } catch {
      // closed
    }
  });
  res.on("error", () => stream.destroy());
}
