// Shared function: build a parquetjs-compatible schema from a sample row,
// using LeRobot feature definitions to preserve correct types (FLOAT vs DOUBLE,
// INT32 vs INT64). Without this, parquetjs writes all numbers as DOUBLE/INT64,
// causing type mismatches when concatenating with original parquet files.

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
      // hyparquet returns BigInt for INT64 columns; treat as numeric.
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
    case "int32": return "INT32";
    case "int64": return "INT64";
    case "float32": return "FLOAT";
    case "float64":
    case "double": return "DOUBLE";
    case "bool":
    case "boolean": return "BOOLEAN";
    default: return "DOUBLE";
  }
}
