// Shared scaffolding for the two webview panels we host (episode preview
// and metadata viewer). Subclasses override `onMessage` and the optional
// `extraResourceRoots` hook; everything else — disposal, html shell,
// nonce, message wiring — is identical across panels.

import * as vscode from "vscode";
import type { FromExtensionMessage, FromWebviewMessage } from "./protocol";

export interface BasePanelOptions {
  context: vscode.ExtensionContext;
  /** WebviewPanel ViewType identifier. */
  viewType: string;
  /** Tab title. */
  title: string;
  /** Extra local resource roots beyond `dist/` and `media/`. */
  extraResourceRoots?: vscode.Uri[];
}

export abstract class BaseWebviewPanel {
  protected readonly panel: vscode.WebviewPanel;
  protected readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private readonly _onDidDispose = new vscode.EventEmitter<void>();

  constructor(opts: BasePanelOptions) {
    this.context = opts.context;
    this.panel = vscode.window.createWebviewPanel(
      opts.viewType,
      opts.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(opts.context.extensionUri, "dist"),
          vscode.Uri.joinPath(opts.context.extensionUri, "media"),
          ...(opts.extraResourceRoots ?? []),
        ],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      opts.context.extensionUri,
      "media",
      "icons",
      "lerobot.svg",
    );
    this.panel.webview.html = this.renderHtml();

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: FromWebviewMessage) =>
        this.onMessage(message),
      ),
    );
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }

  onDidDispose(listener: () => void): vscode.Disposable {
    return this._onDidDispose.event(listener);
  }

  protected post(message: FromExtensionMessage): void {
    this.panel.webview.postMessage(message);
  }

  protected abstract onMessage(message: FromWebviewMessage): Promise<void> | void;

  /**
   * Allow subclasses to widen the CSP — e.g., to permit dataset video
   * URIs as a media-src. Returns extra `directive: source-list` pairs.
   */
  protected extraCspDirectives(): Array<[string, string]> {
    return [];
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const nonce = generateNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );

    const baseDirectives: Array<[string, string]> = [
      ["default-src", "'none'"],
      ["img-src", `${webview.cspSource} https: data: blob:`],
      ["style-src", `${webview.cspSource} 'unsafe-inline'`],
      ["font-src", webview.cspSource],
      ["script-src", `'nonce-${nonce}'`],
    ];
    const extras = this.extraCspDirectives();
    const csp = [...baseDirectives, ...extras]
      .map(([k, v]) => `${k} ${v}`)
      .join("; ");

    return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>LeRobot Viewer</title>
  </head>
  <body class="bg-vscode-bg text-vscode-fg">
    <div id="root">
      <div style="padding:16px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);">
        Initializing webview…
      </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
