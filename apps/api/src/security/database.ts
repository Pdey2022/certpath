export type D1Value = string | number | null | ArrayBuffer | ArrayBufferView;

export interface D1Result {
  meta: { changes: number };
  results?: unknown[];
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T>(): Promise<{ meta: { changes: number }; results: T[] }>;
}

export interface D1ReadSession {
  prepare(query: string): D1PreparedStatement;
}

export interface SecurityDatabase extends D1ReadSession {
  withSession(constraint: "first-primary"): D1ReadSession;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export function isValidTokenDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
