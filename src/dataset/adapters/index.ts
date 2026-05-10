import type { DatasetVersion } from "../../types";
import { V21Adapter } from "./V21Adapter";
import { V30Adapter } from "./V30Adapter";
import type { DatasetAdapter } from "./types";

/**
 * Pick an adapter for the given detected version. "unknown" falls back to
 * the v2.1 adapter because that is the most common layout in the wild;
 * the version detector emits a warning so the user knows the choice was
 * heuristic.
 */
export function getAdapter(version: DatasetVersion): DatasetAdapter {
  switch (version) {
    case "v3.0":
      return new V30Adapter();
    case "v2.0":
      return new V21Adapter("v2.0");
    case "v2.1":
      return new V21Adapter("v2.1");
    case "unknown":
    default:
      return new V21Adapter("v2.1");
  }
}

export type { DatasetAdapter, VideoLocation, AdapterContext } from "./types";
export { V21Adapter, V30Adapter };
