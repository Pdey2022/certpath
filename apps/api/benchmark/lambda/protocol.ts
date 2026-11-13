export interface BenchmarkMetrics {
  coldStart: boolean;
  cpuSystemMs: number;
  cpuUserMs: number;
  elapsedMs: number;
  memoryLimitMb: number | null;
  processPeakRssBytes: number;
  processRssBytes: number;
  requestId: string;
}

export type BenchmarkRequest =
  | { operation: "hash"; password: string }
  | { operation: "verify"; password: string; encodedHash: string };

export type BenchmarkResponse =
  | {
      operation: "hash";
      encodedHash: string;
      metrics: BenchmarkMetrics;
    }
  | {
      operation: "verify";
      verified: boolean;
      metrics: BenchmarkMetrics;
    };
