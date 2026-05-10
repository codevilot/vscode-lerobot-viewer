# LeRobot Viewer

Browse, scrub and inspect Hugging Face [LeRobot](https://github.com/huggingface/lerobot) datasets directly inside VS Code — no Python, no Rerun install required.

![LeRobot Viewer](https://raw.githubusercontent.com/codevilot/vscode-lerobot-viewer/main/media/icon.png)

## Features

- **Multi-source dataset browser** — local folders, Hugging Face repos, and remote SSH hosts in one tree
- **Episode preview** with synchronized video, signal graphs, 2D trajectory plot, and a smooth 60 fps timeline cursor
- **Native parquet decoding** (via [`hyparquet`](https://github.com/hyparam/hyparquet)) for `observation.state`, `action`, `velocity`, `effort`, `environment_state`, `next.reward`, `next.done`, `next.success`, `next.truncated`, `task_index`
- **Dataset metadata viewer** — KPIs, splits, tasks, schema groups, dataset-wide signal range cards, raw `info.json`
- **Format coverage** — LeRobot v2.0 / v2.1 (per-episode parquet/mp4) and v3.0 (sharded), with metadata-driven shard lookup
- **Remote SSH datasets** — pick a host from `~/.ssh/config`, browse remote folders interactively, mirror metadata to local cache, lazy-fetch parquet/video on demand
- **Keyboard shortcuts** — `Space` play/pause, `← →` ±1 frame, `J/L` ±1 second, `R` loop, `Home/End` jump

## Quick start

1. Install the extension from the VS Code marketplace.
2. Open a folder containing a LeRobot dataset (`meta/info.json` is the marker).
3. Click the LeRobot icon in the activity bar — datasets are auto-detected.
4. Click an episode to preview, or click **Metadata** to open the full schema viewer.

### Remote (SSH) datasets

The toolbar's 🌐 button opens a wizard:

1. Pick a host from `~/.ssh/config`, or enter `user@host[:port]` manually.
2. Browse the remote filesystem with QuickPick — folders that look like LeRobot datasets are tagged.
3. Pick the folder. The extension mirrors `meta/` locally and lazy-downloads parquet/video on first preview.

Authentication priority: `ssh-agent` → identity file → password / passphrase prompt. If you hit the ssh2 OpenSSH integrity-check bug, run `ssh-add <key>` once and retry.

### Hugging Face datasets

Click the cloud icon and enter a `namespace/name` repo id. Metadata is fetched into a local cache; data files load on demand from the HF CDN.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `lerobotViewer.autoScanWorkspace` | `true` | Auto-detect datasets in workspace folders on activation |
| `lerobotViewer.workspaceScanDepth` | `3` | How deep to recurse when scanning |
| `lerobotViewer.huggingfaceCacheDir` | `""` | Override `~/.cache/lerobot-viewer` |
| `lerobotViewer.rerunExecutable` | `"rerun"` | Path to the optional Rerun viewer binary |
| `lerobotViewer.enableRerun` | `false` | Surface the "Open in Rerun" button (requires Rerun installed) |

## Architecture

```
src/
├── dataset/
│   ├── adapters/             ← v2.x and v3.0 dataset format adapters
│   ├── ssh/                  ← config / connection / browser / fetch
│   ├── DatasetVersionDetector.ts
│   ├── datasetLoader.ts      ← top-level facade
│   ├── datasetService.ts
│   ├── huggingface.ts
│   └── parquetReader.ts      ← hyparquet decoding
├── webview/
│   ├── baseWebviewPanel.ts   ← shared panel scaffolding
│   ├── episodePreviewPanel.ts
│   ├── metadataViewerPanel.ts
│   └── protocol.ts
└── extension.ts

webview/
├── App.tsx                   ← episode preview React tree
├── MetadataView.tsx          ← metadata viewer React tree
├── components/               ← Header, TransportBar, SignalGraph, ...
└── hooks/                    ← usePlayback, usePlaybackShortcuts
```

Adapters are pure-Node (no `vscode` import) so they're unit-testable. The `DatasetVersionDetector` reads `codebase_version` from `info.json` and falls back to layout heuristics for ambiguous datasets.

## Development

```bash
npm install
npm run watch          # esbuild + tailwind in watch mode
# F5 in VS Code → "Run Extension"
npm test               # node:test against adapters / config parser
npm run typecheck
npm run build          # production bundle
```

## License

Apache-2.0
