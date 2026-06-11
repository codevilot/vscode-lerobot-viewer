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
  return json.replace(
    /(?<=[\[,]\s*)(-?\d+)(?=\s*[,\]])/g,
    (_, digits: string) => `${digits}.0`,
  );
}
