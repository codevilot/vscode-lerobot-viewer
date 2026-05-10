# Changelog

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
