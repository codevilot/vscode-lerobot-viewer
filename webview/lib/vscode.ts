// Thin wrapper around the webview <-> extension messaging surface.
// `acquireVsCodeApi` may only be called once per webview lifetime, so we
// memoize behind a module-level singleton.

import type {
  FromExtensionMessage,
  FromWebviewMessage,
  WebviewBridge,
} from "../../src/webview/protocol";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

let cached: WebviewBridge | undefined;

export function getBridge(): WebviewBridge {
  if (cached) return cached;
  const api = acquireVsCodeApi();
  cached = {
    postMessage(msg: FromWebviewMessage) {
      api.postMessage(msg);
    },
    onMessage(handler) {
      const wrapped = (event: MessageEvent<FromExtensionMessage>) => handler(event.data);
      window.addEventListener("message", wrapped);
      return () => window.removeEventListener("message", wrapped);
    },
    setState(state) {
      api.setState(state);
    },
    getState() {
      return api.getState();
    },
  };
  return cached;
}
