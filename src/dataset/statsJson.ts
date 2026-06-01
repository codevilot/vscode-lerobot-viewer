// Write stats records as JSONL with all numeric arrays forced to float.
// JavaScript JSON doesn't distinguish 0 from 0.0, but Python json.load
// deserializes 0 as int and 0.0 as float — causing Arrow concat failures
// when different episodes' stats have mixed int/float types for the same field.

import * as fs from "node:fs/promises";

export async function writeStatsJsonl(
  filePath: string,
  records: Record<string, unknown>[],
): Promise<void> {
  const lines = records
    .map((rec) => JSON.stringify(rec, floatReplacer))
    .join("\n") + "\n";
  await fs.writeFile(filePath, lines, "utf8");
}

function floatReplacer(_key: string, value: unknown): unknown {
  // Convert integer numbers in arrays to non-integer floats by adding
  // a tiny epsilon. Arrays in stats contain only numeric values.
  if (Array.isArray(value)) {
    return value.map((v) =>
      typeof v === "number" && Number.isInteger(v) ? v + 1e-12 : v,
    );
  }
  return value;
}
