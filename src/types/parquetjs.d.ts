declare module "parquetjs" {
  export class ParquetSchema {
    constructor(schema: Record<string, unknown>);
  }

  export class ParquetWriter {
    static openFile(
      schema: ParquetSchema,
      path: string,
      opts?: Record<string, unknown>,
    ): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }
}
