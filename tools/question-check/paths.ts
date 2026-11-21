import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { QuestionCheckError, type QuestionCheckErrorCode } from "./errors.ts";

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
 * Question content is read and written outside the repository. A path that
 * resolves inside it is refused before anything is created or read, using the
 * same realpath-up walk the CISSP converter uses.
 *
 * `--profile` and `--taxonomy` are the exception: they are committed schema
 * files with no item text, and the committed profile and taxonomy are inside
 * the repository by design (docs/question-check.md §Path policy).
 */
export function assertOutsideRepository(
  path: string,
  repoRoot: string,
  code: QuestionCheckErrorCode,
): string {
  const canonical = canonicalPath(path);
  if (isInside(canonicalPath(repoRoot), canonical)) {
    throw new QuestionCheckError(code, "the path must be outside the repository");
  }
  return canonical;
}

/** The path recorded in a report: repository-relative when inside, basename otherwise. */
export function reportPath(path: string, repoRoot: string): string {
  const canonical = canonicalPath(path);
  const root = canonicalPath(repoRoot);
  if (isInside(root, canonical)) {
    return canonical.slice(root.length).replace(/^[\\/]+/, "").split(sep).join("/");
  }
  return basename(canonical);
}
