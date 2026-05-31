declare module "parquetjs" {
  export class ParquetWriter {
    static openFile(
      schema: Record<string, unknown>,
      path: string,
    ): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }
}
