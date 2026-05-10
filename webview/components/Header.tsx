import type { EpisodePreviewData } from "../../src/types";

interface HeaderProps {
  data: EpisodePreviewData;
}

export function Header({ data }: HeaderProps) {
  const ep = data.episode;
  const fps = data.info.fps || 30;
  const seconds = ep.length ? (ep.length / fps).toFixed(2) : null;
  return (
    <header className="px-6 pt-5 pb-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <VersionBadge version={data.version} />
            {data.episodeSplit && <SplitBadge name={data.episodeSplit} />}
            {data.dataset.repoId && <span className="lr-badge">HuggingFace</span>}
          </div>
          <h1 className="mt-2 truncate text-[20px] font-semibold leading-tight">{data.dataset.name}</h1>
          <p className="mt-1 truncate text-[12px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
            Episode {ep.episodeIndex.toString().padStart(4, "0")}
            {ep.tasks.length > 0 ? ` · ${ep.tasks[0]}` : ""}
          </p>
        </div>

        <div className="hidden shrink-0 flex-wrap items-center gap-1 self-end pb-1 md:flex">
          <KeyHint k="Space">play</KeyHint>
          <KeyHint k="←→">frame</KeyHint>
          <KeyHint k="J/L">±1s</KeyHint>
          <KeyHint k="R">loop</KeyHint>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-3 md:grid-cols-3">
        <Stat label="Frames" value={ep.length ? ep.length.toLocaleString() : "—"} />
        <Stat label="Duration" value={seconds ? `${seconds}s` : "—"} />
        <Stat label="FPS" value={String(data.info.fps)} />
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="lr-card-pad">
      <div className="lr-stat-label">{label}</div>
      <div className="lr-stat-value mt-1.5">{value}</div>
    </div>
  );
}

function KeyHint({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-[color-mix(in_srgb,var(--vscode-foreground)_55%,transparent)]">
      <kbd>{k}</kbd>
      <span>{children}</span>
    </span>
  );
}

function SplitBadge({ name }: { name: string }) {
  // train→green, val/eval→amber, test→blue, others→neutral.
  const cls =
    name === "train"
      ? "lr-badge lr-badge-v3"
      : name.startsWith("val") || name.startsWith("eval")
        ? "lr-badge lr-badge-warn"
        : name === "test"
          ? "lr-badge lr-badge-v2"
          : "lr-badge";
  return <span className={cls}>{name}</span>;
}

function VersionBadge({ version }: { version: EpisodePreviewData["version"] }) {
  const cls =
    version === "v3.0" ? "lr-badge lr-badge-v3" :
    version === "unknown" ? "lr-badge lr-badge-warn" :
    "lr-badge lr-badge-v2";
  return <span className={cls}>{version}</span>;
}
