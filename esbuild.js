// Bundles two artifacts:
//   dist/extension.js  — Node target, consumed by VS Code
//   dist/webview.js    — Browser target, loaded inside the webview iframe
//   dist/webview.css   — Tailwind output for the webview
//
// Tailwind is run as a separate CLI step (postcss) so we don't need the
// esbuild postcss plugin (avoids one more transitive dep).

const esbuild = require("esbuild");
const { spawn } = require("node:child_process");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node18",
  format: "cjs",
  // ssh2 ships optional native bindings (cpu-features, sshcrypto.node) that
  // esbuild can't bundle. Mark the SSH stack external — node will resolve
  // them from node_modules at runtime.
  external: ["vscode", "ssh2", "ssh2-sftp-client", "cpu-features"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewBuild = {
  entryPoints: ["webview/main.tsx"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  target: "es2020",
  format: "iife",
  // Use the React 17+ automatic JSX runtime so we don't need `import React`
  // in every component file.
  jsx: "automatic",
  jsxImportSource: "react",
  sourcemap: !production,
  minify: production,
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
  logLevel: "info",
  loader: { ".css": "empty" },
};

function runTailwind() {
  const args = [
    path.join("node_modules", ".bin", "tailwindcss"),
    "-i", "webview/main.css",
    "-o", "dist/webview.css",
    "--postcss",
  ];
  if (production) args.push("--minify");
  if (watch) args.push("--watch");
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  child.on("exit", (code) => {
    if (!watch && code !== 0) process.exit(code ?? 1);
  });
  return child;
}

async function main() {
  if (watch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionBuild),
      esbuild.context(webviewBuild),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    runTailwind();
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionBuild),
      esbuild.build(webviewBuild),
    ]);
    runTailwind();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
