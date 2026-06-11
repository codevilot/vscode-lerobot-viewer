// Build a parquetjs-compatible schema from a sample row while preserving
// LeRobot feature dtypes. Without this, parquetjs tends to write generic
// DOUBLE/INT64 columns that later fail Arrow concat checks against originals.

const INTERNAL_TYPES: Record<string, string> = {
  episode_index: "INT64",
  frame_index: "INT64",
  timestamp: "DOUBLE",
  index: "INT64",
  task_index: "INT64",
};

export function buildParquetSchema(
  row: Record<string, unknown>,
  features?: Record<string, { dtype: string }>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    const feat = features?.[key];
    const knownType = INTERNAL_TYPES[key];
    if (Array.isArray(value)) {
      const elemType = knownType ?? (feat ? dtypeToParquet(feat.dtype) : "DOUBLE");
      fields[key] = { type: elemType, repeated: true };
    } else if (typeof value === "number" || typeof value === "bigint") {
      fields[key] = { type: knownType ?? (feat ? dtypeToParquet(feat.dtype) : "DOUBLE") };
    } else if (typeof value === "boolean") {
      fields[key] = { type: "BOOLEAN" };
    } else {
      fields[key] = { type: "UTF8" };
    }
  }
  return fields;
}

function dtypeToParquet(dtype: string): string {
  switch (dtype) {
    case "int32":
      return "INT32";
    case "int64":
      return "INT64";
    case "float32":
      return "FLOAT";
    case "float64":
    case "double":
      return "DOUBLE";
    case "bool":
    case "boolean":
      return "BOOLEAN";
    default:
      return "DOUBLE";
  }
}
