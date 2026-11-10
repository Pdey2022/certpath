import type { D1Migration } from "cloudflare:test";
import type {
  D1PreparedStatement,
  D1Result,
  SecurityDatabase,
} from "../src/security/database.ts";

declare global {
  interface D1Database extends SecurityDatabase {
    batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]>;
    exec(query: string): Promise<unknown>;
  }

  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
