declare module "better-sqlite3-multiple-ciphers" {
  export default class Database {
    constructor(path: string);
    pragma(statement: string): unknown;
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): { changes: number };
      get(...values: unknown[]): any;
      all(...values: unknown[]): any[];
    };
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }
}
