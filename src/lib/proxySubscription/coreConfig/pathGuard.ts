/**
 * Guard for the subscription's adopted core-config path (opt-in generation).
 *
 * Pure and dependency-free: no disk access here. The sync step pre-checks
 * the target directory separately (best-effort) and never creates it.
 */
import path from "node:path";

export type CoreConfigPathReason =
  "empty" | "too_long" | "nul_byte" | "not_absolute" | "dotdot_segment" | "bad_extension";

export interface CoreConfigPathVerdict {
  allowed: boolean;
  reason?: CoreConfigPathReason;
}

const MAX_PATH_LENGTH = 1024;

/**
 * Whether `p` is an acceptable adopted core-config path: non-empty,
 * at most 1024 chars, no NUL byte, absolute, no `..` segment, `.json`
 * extension (case-sensitive). Never throws.
 */
export function isCoreConfigPathAllowed(p: string): CoreConfigPathVerdict {
  try {
    if (typeof p !== "string" || p.length === 0) return { allowed: false, reason: "empty" };
    if (p.length > MAX_PATH_LENGTH) return { allowed: false, reason: "too_long" };
    if (p.includes("\0")) return { allowed: false, reason: "nul_byte" };
    if (!path.isAbsolute(p)) return { allowed: false, reason: "not_absolute" };
    if (p.split("/").includes("..") || p.split(path.sep).includes("..")) {
      return { allowed: false, reason: "dotdot_segment" };
    }
    if (!p.endsWith(".json")) return { allowed: false, reason: "bad_extension" };
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "empty" };
  }
}
