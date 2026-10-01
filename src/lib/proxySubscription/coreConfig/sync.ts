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
import { applyRendered, type ApplyBesideReason, type RunCheck } from "./apply";
import { buildCoreModel, type CoreModel } from "./model";
import {
  DEFAULT_CORE,
  OFFENDING_RESOLVERS,
  RENDERERS,
  type RenderOk,
  type RenderRefused,
} from "./renderers";

export interface CoreConfigSub {
  coreConfigPath: string | null;
  coreBinaryPath: string | null;
  localCoreEndpoint: string | null;
  id?: string;
}

/** Encode a sync warning without importing the service (cycle-free). */
function encodeWarning(code: string, detail?: string): string {
  return JSON.stringify(detail ? { code, detail } : { code });
}

function warn(reason: string): string {
  return encodeWarning("CORE_CONFIG_NOT_GENERATED", reason);
}

/** Maximum nodes pruned after a rejected verification (bounded retries). */
export const MAX_PRUNE_ATTEMPTS = 8;

/** Test-only overrides. The service caller passes none of these. */
export interface GenerateOptions {
  runCheck?: RunCheck;
  maxPruneAttempts?: number;
}

/**
 * Render and apply the beside-file for one subscription. Returns the encoded
 * warning when nothing usable was written, null on success or when the
 * feature is off (empty path). Never throws — sync must never fail because
 * generation did.
 *
 * With a binary path configured, the rendered text is verified with the
 * core's native check before replacing the adopted file (a pass swaps it in
 * atomically, a miss writes `<path>.generated` beside it and warns).
 * Without one, the beside-file is written directly as before.
 */
export async function generateForSubscription(
  sub: CoreConfigSub,
  parsed: ParsedSubscription,
  opts?: GenerateOptions
): Promise<string | null> {
  const target = (sub.coreConfigPath ?? "").trim();
  if (!target) return null;

  const existingText = readExisting(target);
  if (existingText.failed) return warn("read_failed");

  const model = buildCoreModel(parseLocalCoreEndpoints(sub.localCoreEndpoint), [
    ...parsed.nodes,
    ...parsed.needsCore,
  ]);
  const renderer = RENDERERS[DEFAULT_CORE];
  const result = renderer(model, existingText.text);
  if (!result.ok) return warn((result as RenderRefused).reason);
  if (result.unchanged) return null;

  const dir = path.dirname(`${target}.generated`);
  try {
    if (!fs.statSync(dir).isDirectory()) return warn("write_failed");
  } catch {
    return warn("write_failed");
  }
  const binaryPath = (sub.coreBinaryPath ?? "").trim();
  if (binaryPath)
    return applyVerified(sub, target, binaryPath, model, existingText.text, result, opts);
  return writeBeside(target, result.text);
}

/** Read the beside-file, falling back to the adopted file. Never throws. */
function readExisting(target: string): { failed: boolean; text: string | null } {
  try {
    return { failed: false, text: readPrivateConfigFile(`${target}.generated`) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { failed: true, text: null };
    try {
      return { failed: false, text: readPrivateConfigFile(target) };
    } catch (adoptedError) {
      if ((adoptedError as NodeJS.ErrnoException)?.code !== "ENOENT")
        return { failed: true, text: null };
      return { failed: false, text: null };
    }
  }
}

/** Write the beside-file directly (no binary configured). Never throws. */
function writeBeside(target: string, text: string): string | null {
  try {
    writePrivateConfigFile(`${target}.generated`, text);
    return null;
  } catch {
    return warn("write_failed");
  }
}

/**
 * Verify the rendered text with the core's native check before replacing
 * the adopted file: a pass swaps it in atomically, a miss writes
 * `<path>.generated` beside it and warns. Never throws.
 *
 * When the check names an offending node, that node is pruned from the model
 * (recorded in `skipped` with reason `core_rejected`), the candidate is
 * re-rendered and the check runs again — bounded by MAX_PRUNE_ATTEMPTS
 * (1 initial check + up to 8 prune rounds). Pruned-away successes still warn
 * (`pruned:<n>:core_rejected`) so the removal surfaces in the subscription
 * warning; anything unattributable keeps the previous behaviour.
 */
async function applyVerified(
  sub: CoreConfigSub,
  target: string,
  binaryPath: string,
  model: CoreModel,
  existingText: string | null,
  first: RenderOk,
  opts?: GenerateOptions
): Promise<string | null> {
  const limit = opts?.maxPruneAttempts ?? MAX_PRUNE_ATTEMPTS;
  const pruned: Array<{ node: string; detail: string }> = [];
  let current = first;
  for (let round = 0; ; round += 1) {
    const outcome = await runVerifiedRound(sub, target, binaryPath, current, opts);
    if (outcome === null) return prunedWarning(pruned);
    if (outcome.done) return outcome.warning;
    const failed = outcome as { done: false; tag: string; detail: string | undefined; beside: ApplyBesideReason | undefined };
    if (round >= limit) return warn(applyReason(failed.beside));
    const next = advancePruneRound(model, existingText, failed.tag, failed.detail, pruned);
    if (next === null) {
      // Drained model: never serve an empty replacement — previous behaviour.
      if (model.nodes.length === 0) return warn("check_failed");
      return pruned.length > 0 ? prunedWarning(pruned) : warn("check_failed");
    }
    current = next;
    console.warn(
      `[ProxySubscription] core apply ${sub.id ?? ""}: pruned ${pruned.length} rejected nodes in ${round + 1} attempts`
    );
  }
}

/** Success-with-prunes still warns so the removal surfaces; clean pass is null. */
function prunedWarning(done: Array<{ node: string; detail: string }>): string | null {
  return done.length > 0 ? warn(`pruned:${done.length}:core_rejected`) : null;
}

/** One check round: replaced → null, beside without a tag → terminal warning. */
async function runVerifiedRound(
  sub: CoreConfigSub,
  target: string,
  binaryPath: string,
  current: RenderOk,
  opts?: GenerateOptions
): Promise<
  | null
  | { done: true; warning: string }
  | { done: false; tag: string; detail: string | undefined; beside: ApplyBesideReason | undefined }
> {
  let outcome;
  try {
    outcome = await applyRendered({
      adoptedPath: target,
      binaryPath,
      renderedText: current.text,
      subscriptionId: sub.id ?? "",
      ...(opts?.runCheck ? { runCheck: opts.runCheck } : {}),
      ...resolveHook(current),
    });
  } catch {
    return { done: true, warning: warn("write_failed") };
  }
  if (outcome.status === "replaced") return null;
  const tag = outcome.offending?.tag;
  if (!tag) return { done: true, warning: warn(applyReason(outcome.beside)) };
  return { done: false, tag, detail: outcome.offending?.detail, beside: outcome.beside };
}

/**
 * Consume one named tag: model prune, then re-render. Returns the next
 * candidate, or null when the loop must stop (no-op prune, empty model,
 * refused or unchanged re-render).
 */
function advancePruneRound(
  model: CoreModel,
  existingText: string | null,
  tag: string,
  detail: string | undefined,
  pruned: Array<{ node: string; detail: string }>
): RenderOk | null {
  if (!pruneModel(model, tag, detail, pruned)) return null;
  if (model.nodes.length === 0) return null;
  const next = RENDERERS[DEFAULT_CORE](model, existingText);
  if (!next.ok) return null;
  if (next.unchanged) return null;
  return next;
}

/**
 * Resolve the offending-node hook for one rendered candidate: the resolver
 * registered for the default core plus this render's owned-position table.
 * Absent either, the check reports `check_failed` as before.
 */
function resolveHook(rendered: RenderOk):
  | {
      offending: {
        resolve: (
          stderr: string,
          owned: Array<string | null>
        ) => { tag: string; token: string } | null;
        table: Array<string | null>;
      };
    }
  | Record<string, never> {
  const resolve = OFFENDING_RESOLVERS[DEFAULT_CORE];
  const table = rendered.ownedIndex;
  if (!resolve || !table) return {};
  return { offending: { resolve, table } };
}

/**
 * Drop one rejected node from the model: filter nodes and group members,
 * record the removal in `skipped` with reason `core_rejected` and the masked
 * generic detail in the loop-local pruned list. False when the tag removes
 * nothing (unknown or duplicate tag) — the loop then keeps the previous
 * behaviour instead of spinning.
 */
function pruneModel(
  model: CoreModel,
  tag: string,
  detail: string | undefined,
  pruned: Array<{ node: string; detail: string }>
): boolean {
  const before = model.nodes.length;
  model.nodes = model.nodes.filter((n) => n.tag !== tag);
  for (const group of model.groups) group.members = group.members.filter((m) => m !== tag);
  if (model.nodes.length === before) return false;
  model.skipped.push({ node: tag, reason: "core_rejected" });
  pruned.push({ node: tag, detail: (detail ?? "offending-pattern:unknown").slice(0, 500) });
  return true;
}

/**
 * Map an apply beside-reason to the sync warning detail. The `no_binary`
 * case cannot happen here (guarded above) — it still maps, defensively.
 */
function applyReason(beside: ApplyBesideReason | undefined): string {
  switch (beside) {
    case "binary_missing":
    case "check_failed":
      return "check_failed";
    case "unchanged_skip":
      return "unchanged";
    case "write_failed":
      return "write_failed";
    default:
      return "not_applied";
  }
}
