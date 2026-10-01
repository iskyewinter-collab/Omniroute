/**
 * Sync-side generation: render the core config beside the adopted file.
 *
 * This is the only file of the generation feature that touches the disk.
 * It reads the adopted file with `readPrivateConfigFile` (read-only here —
 * the adopted file is never modified) and writes `<path>.generated` with
 * `writePrivateConfigFile` (atomic, symlink-refusing, mode 0600).
 *
 * Note: the writer creates a missing target directory internally, so the
 * directory check below is best-effort only — it warns first without
 * creating anything; a directory removed in between still gets created by
 * the writer (the write itself stays atomic either way).
 */
import fs from "node:fs";
import path from "node:path";
import { readPrivateConfigFile, writePrivateConfigFile } from "@/lib/cli-helper/privateConfigFile";
import { parseLocalCoreEndpoints } from "../coreEndpoint";
import type { ParsedSubscription } from "../parse";
import { buildCoreModel } from "./model";
import { DEFAULT_CORE, RENDERERS, type RenderRefused } from "./renderers";

export interface CoreConfigSub {
  coreConfigPath: string | null;
  localCoreEndpoint: string | null;
}

/** Encode a sync warning without importing the service (cycle-free). */
function encodeWarning(code: string, detail?: string): string {
  return JSON.stringify(detail ? { code, detail } : { code });
}

function warn(reason: string): string {
  return encodeWarning("CORE_CONFIG_NOT_GENERATED", reason);
}

/**
 * Render and write the beside-file for one subscription. Returns the encoded
 * warning when nothing usable was written, null on success or when the
 * feature is off (empty path). Never throws — sync must never fail because
 * generation did.
 */
export async function generateForSubscription(
  sub: CoreConfigSub,
  parsed: ParsedSubscription
): Promise<string | null> {
  try {
    const target = (sub.coreConfigPath ?? "").trim();
    if (!target) return null;

    const generatedPath = `${target}.generated`;
    let existingText: string | null = null;
    try {
      existingText = readPrivateConfigFile(generatedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return warn("read_failed");
      }
      try {
        existingText = readPrivateConfigFile(target);
      } catch (adoptedError) {
        if ((adoptedError as NodeJS.ErrnoException)?.code !== "ENOENT") {
          return warn("read_failed");
        }
      }
    }

    const model = buildCoreModel(parseLocalCoreEndpoints(sub.localCoreEndpoint), [
      ...parsed.nodes,
      ...parsed.needsCore,
    ]);
    const renderer = RENDERERS[DEFAULT_CORE];
    const result = renderer(model, existingText);
    if (!result.ok) return warn((result as RenderRefused).reason);
    if (result.unchanged) return null;

    const dir = path.dirname(generatedPath);
    try {
      if (!fs.statSync(dir).isDirectory()) return warn("write_failed");
    } catch {
      return warn("write_failed");
    }
    try {
      writePrivateConfigFile(generatedPath, result.text);
    } catch {
      return warn("write_failed");
    }
    return null;
  } catch {
    return warn("write_failed");
  }
}
