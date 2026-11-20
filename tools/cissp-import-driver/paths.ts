import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DriverError, type DriverErrorCode } from "./errors.ts";

/** Canonicalises a possibly non-existent path by walking up to a real parent. */
export function canonicalPath(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }
  const parent = dirname(resolved);
  if (parent === resolved) return resolved;
  return join(canonicalPath(parent), basename(resolved));
}

export function isInside(parent: string, child: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const parentPath = normalize(parent);
  const childPath = normalize(child);
  if (childPath === parentPath) return true;
  const boundary = parentPath.endsWith(sep) ? parentPath : `${parentPath}${sep}`;
  return childPath.startsWith(boundary);
}

/**
 * Every file the driver writes lives outside the repository. A path that
 * resolves inside it is refused before anything is created.
 */
export function assertOutsideRepository(
  path: string,
  repoRoot: string,
  code: DriverErrorCode,
): string {
  const canonical = canonicalPath(path);
  if (isInside(canonicalPath(repoRoot), canonical)) {
    throw new DriverError(code, "the path must be outside the repository");
  }
  return canonical;
}
