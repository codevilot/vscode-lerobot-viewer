// Stats JSON serializer. JavaScript JSON drops the decimal from "1.0" → "1",
// causing Python json.load to infer int64 instead of float64, which Arrow
// refuses to concat with genuine float arrays from other episodes.
//
// Fix: post-process the JSON string — append ".0" to every numeric literal
// that appears inside a JSON array (i.e. between [ and ] or after , inside
// an array). This forces Python to parse all array elements as floats.

import * as fs from "node:fs/promises";

export async function writeStatsJsonl(
  filePath: string,
  records: Record<string, unknown>[],
): Promise<void> {
  const lines = records
    .map((rec) => JSON.stringify(rec))
    .map(floatifyArraysInJson)
    .join("\n") + "\n";
  await fs.writeFile(filePath, lines, "utf8");
}

export function floatifyArraysInJson(json: string): string {
  // Match numeric literals that are array elements:
  // - preceded by [ or , (with optional whitespace)
  // - followed by , or ] (with optional whitespace)
  // Must not already contain a dot, 'e', or 'E'.
  return json.replace(
    /(?<=[\[,]\s*)(-?\d+)(?=\s*[,\]])/g,
    (_, digits) => digits + ".0",
  );
}
