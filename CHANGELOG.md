# Changelog

## 0.1.4

Episode page redesign + a pass over SSH dataset reliability.

### Episode page
- Two-pane layout: cameras + playback dock on the left, episode meta + a per-dim state/action grid on the right. The right pane is draggable (360–1100 px) and falls back to a top/bottom 50/50 stack when the panel is narrower than 720 px.
- New SignalGrid: one row per dim, paired across two columns (state in blue, action in orange). Behind each line a diff band paints |state − action| / σ — olive at ≥ 1σ, red at ≥ 3σ — so tracking error is visible at a glance. Click any chart to seek.
- Removed components subsumed by the new layout: MetadataPanel sidebar, SignalGraph cards, StateActionCompare overlay, TrajectoryPlot 2D, EventMarkers bar, LengthHistogram, EpisodeStrip, the big Frames/Duration/FPS header, and the Compare toggle + chart-height slider. Webview bundle ~30 KB smaller.

### Faster first paint (especially over SSH)
- Two-stage init: the webview now receives metadata + cameras as soon as videos resolve, then a follow-up `init-signals` message fills the state/action grid once parquet decode finishes. SignalGrid shows a skeleton ("Decoding signals…") in between, so a multi-second SSH shard download no longer leaves a blank panel.
- v3.0 parquet shards now decode only the row range belonging to the current episode (`hyparquet rowStart/rowEnd`) instead of the entire multi-episode shard. Roughly 10× faster decode on typical 10-episodes-per-shard layouts.
- Camera URIs resolve in parallel — a multi-camera SSH dataset no longer pays for sequential downloads.

### SSH connection robustness
- Sessions for registered SSH datasets stay alive for the lifetime of the VS Code window: pinned in the pool (no idle close), warmed up silently on activate, and auto-reconnected with exponential backoff (1.5 s → 5 s → 15 s → 60 s) when a network drop kills the underlying socket.
- The first time you type a password / passphrase, it's cached in memory for the session. Silent reconnects and warm-ups reuse it, so a transient drop mid-playback no longer pops a password box. The cache is never persisted to disk and is wiped on deactivate.
- Tree view shows the live connection state: green filled circle = connected, spinner = connecting, grey outline = disconnected. Tooltip carries the same info plus the host:path.

### Cache hygiene
- Removing an SSH dataset now wipes its globalStorage cache (the downloaded meta + per-episode files) along with the descriptor.
- Orphan cache directories — left over from datasets that aren't registered anymore — get cleaned up automatically at activate.
- A `.last-access` sentinel is touched on every cache hit / fresh download; cache dirs not accessed for 24 hours get reclaimed on the next activate (descriptor stays, meta re-downloads on next open).
- New "LeRobot: Clean SSH cache" command for explicit "delete everything" after a confirmation.

## 0.1.3

Add-dataset flow overhaul, driven by user friction with the SSH wizard ("계속 암호를 묻는게 소켓통신이 지속적으로 끊어지는거같은데", "내부에 있는것도 그 안에 르로봇데이터셋이 있나보고 추가하게", "만일 없는데가있으면그냥없는거지 에러가나올필요는없어").

- SSH: SFTP sessions are now pooled per (user@host:port, identityFile). The browse → probe → fetch → on-demand file download chain shares a single live session instead of opening a fresh one each step, so adding an SSH dataset prompts for the password at most once. Idle sessions stay cached for 5 minutes and survive server-side inactivity via keepalive; lifecycle listeners evict dead sessions transparently.
- SSH: new "Scan for LeRobot datasets here…" action in the remote folder picker. Bounded BFS (depth ≤ 4, concurrency 12, ≤ 100 results, ≤ 2000 dirs) with cancellable progress, ignores noise dirs (node_modules, .git, __pycache__, venv, …), and recurses past dataset boundaries to catch nested datasets while pruning the dataset's own data/videos/images/meta chunks.
- Add-dataset UX: both the local "Open LeRobot dataset" picker and the SSH wizard now auto-scan whatever folder you point at and register every LeRobot dataset they find — the picked folder included, plus any nested ones. The "Folder is not a LeRobot dataset (missing meta/info.json)" hard error is gone: an empty scan is silent.
- Dedupe: registered datasets are now deduplicated by root path, not by source-prefixed id. A folder discovered by workspace auto-scan won't be re-added as a manual entry, and re-running the picker on an already-registered tree is a true no-op. A brief info toast confirms the count whenever something new is added.

## 0.1.2

Episode page overhaul driven by user feedback ("action/states viewer가 더 잘 보였으면", "action과 states 비교가 편했으면", "정확한 숫자값이 눈에 잘 들어왔으면").

- Fix: opening the integrated terminal or otherwise shrinking the viewer pane no longer clips the bottom of the episode page. The main column now scrolls when content overflows; transport bar, timeline, and task band stick to the top so playback controls stay reachable.
- Episode page: right-hand metadata sidebar width is draggable (240–720 px), double-click to reset, arrow keys for fine adjustment.
- Episode page: each camera card has a 👁 toggle. Hidden cameras are unmounted (decoding paused), surfaced as restorable chips, and the layout reflows. Visibility is remembered per dataset id.
- Episode page: the top of the sticky header shows a large frame / time / task readout (22 px). The redundant time readout in the transport bar is removed.
- SignalGraph: per-dimension cursor values are now 18 px bold and right-aligned, with mean (μ) under the label and the min↔max range bar visible at all viewport widths. Also fixes a long-standing bug where the value marker on the range bar was stuck at 0 %.
- SignalGraph: chart height is configurable via a slider in the signals toolbar (80–400 px, default 160 px), persisted across reloads.
- SignalGraph: new "Compare state vs action" toggle. When enabled, the State and Action cards are replaced with per-dim mini charts that overlay state (blue) and action (orange) on shared axes — the canonical robotics tracking-error view. Δ readout flags large errors in red. Handles mismatched dim counts gracefully.

## 0.1.1

- Fix: extension failed to activate on a clean install — every welcome-view button (Add dataset folder, Add Hugging Face dataset, Scan workspace, Add SSH dataset) reported `command 'lerobotViewer.*' not found`. The packaged vsix was missing transitive deps of `ssh2-sftp-client` (`util-deprecate`, `string_decoder`, `safe-buffer`), so the static import in `src/dataset/ssh/connection.ts` threw at module load time and `activate()` never ran. `ssh2-sftp-client` and its pure-JS deps are now bundled into `dist/extension.js`; only `ssh2` and `cpu-features` (which carry native `.node` bindings) stay external.

## 0.1.0

Initial release.

- Dataset explorer sidebar with workspace auto-scan, manual folder add, Hugging Face repo add, and SSH remote add
- Episode preview with synchronized video, transport bar (play/pause, ±1 frame, ±1 second, speed, loop), 60 fps smooth timeline cursor
- Native parquet decoding via hyparquet for state, action, velocity, effort, environment_state, reward, done, success, truncated, task_index
- 2D trajectory plot, dim-toggle legend, dataset-wide range bars
- Dedicated metadata viewer (KPIs, splits, tasks, schema groups, raw info.json)
- LeRobot v2.0 / v2.1 / v3.0 support with metadata-driven shard lookup
- SSH support: ~/.ssh/config aware, interactive remote folder browser, ssh-agent priority, lazy file fetch with progress
- Theme-aware Toss-style UI built on VS Code design tokens
