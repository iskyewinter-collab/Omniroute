/**
 * Core-agnostic generation model: what OmniRoute owns (local listeners,
 * selector groups, node tags) — never how a protocol is translated.
 *
 * It doesn't model outbound protocol payloads: each node carries its
 * original definition untouched (`source`), and a renderer passes it through
 * verbatim or skips it with a reason.
 */
import { createHash } from "node:crypto";
import type { NeedsCoreNode, NodeSource, SubscriptionNode } from "../parse";
import { isLocalCoreEndpointAllowed } from "../coreEndpoint";
import { parseSelectorTag, stripSelectorSuffix } from "../selectorEndpoint";

/** Prefix marking every tag this generator owns (listeners, groups, nodes). */
export const OWNED_TAG_PREFIX = "omniroute-";

export interface CoreListener {
  tag: string;
  scheme: "socks5" | "http" | "https";
  host: string;
  port: number;
  group: string;
}

export interface CoreGroup {
  tag: string;
  members: string[];
}

export interface CoreNode {
  tag: string;
  source: NodeSource;
}

export interface CoreModel {
  listeners: CoreListener[];
  groups: CoreGroup[];
  nodes: CoreNode[];
  skipped: Array<{ line?: string; node?: string; reason: string }>;
}

function hashSlot(name: string, slots: number): number {
  const digest = createHash("sha256").update(name, "utf8").digest();
  return digest.readUInt32BE(0) % slots;
}

function uniqueTag(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  const tag = `${base}-${i}`;
  taken.add(tag);
  return tag;
}

function listenerPort(url: URL, scheme: "socks5" | "http" | "https"): number {
  const port = Number(url.port);
  if (port > 0) return port;
  return scheme === "https" ? 443 : scheme === "http" ? 80 : 1080;
}

function listenerFromLine(
  line: string,
  index: number,
  skipped: CoreModel["skipped"]
): CoreListener | null {
  const tag = parseSelectorTag(line);
  if (!tag) {
    skipped.push({ line, reason: "no_selector_tag" });
    return null;
  }
  const bare = stripSelectorSuffix(line);
  if (!isLocalCoreEndpointAllowed(bare)) {
    skipped.push({ line, reason: "invalid_endpoint" });
    return null;
  }
  let url: URL;
  try {
    url = new URL(bare);
  } catch {
    skipped.push({ line, reason: "invalid_endpoint" });
    return null;
  }
  const scheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : "socks5";
  const group = `${OWNED_TAG_PREFIX}${tag}`;
  return {
    tag: `${OWNED_TAG_PREFIX}in-${tag}-${index}`,
    scheme,
    host: url.hostname,
    port: listenerPort(url, scheme),
    group,
  };
}

function assignNodes(
  nodes: Array<SubscriptionNode | NeedsCoreNode>,
  groups: string[],
  groupMembers: Map<string, CoreNode[]>,
  skipped: CoreModel["skipped"]
): CoreNode[] {
  const taken = new Set<string>();
  const coreNodes: CoreNode[] = [];
  for (const node of nodes) {
    const source = node.source;
    if (!source) {
      skipped.push({ node: node.name, reason: "no_source" });
      continue;
    }
    const tag = uniqueTag(node.name || "node", taken);
    coreNodes.push({ tag, source });
    const group = groups[hashSlot(node.name || "node", groups.length)];
    groupMembers.get(group)!.push({ tag, source });
  }
  return coreNodes;
}

/**
 * Build the generation model from local-core lines and parsed nodes.
 *
 * `entries` are the already-split `localCoreEndpoint` lines (one per line).
 * Lines without a `selector=` suffix or with a disallowed endpoint land in
 * `skipped`; every other line becomes one listener. Lines sharing a selector
 * tag form one group. Each node with a `source` joins exactly one group by
 * `sha256(node name) % group count`, so adding a node never moves the others.
 * Without any group the model stays empty: nodes are neither rendered nor
 * listed, and the renderer emits nothing owned.
 */
export function buildCoreModel(
  entries: string[],
  nodes: Array<SubscriptionNode | NeedsCoreNode>
): CoreModel {
  const skipped: CoreModel["skipped"] = [];
  const listeners: CoreListener[] = [];
  const groupTags = new Map<string, string>();
  const groupMembers = new Map<string, CoreNode[]>();

  entries.forEach((raw, index) => {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line) return;
    const listener = listenerFromLine(line, index, skipped);
    if (!listener) return;
    if (!groupTags.has(listener.group)) {
      groupTags.set(parseSelectorTag(line)!, listener.group);
      groupMembers.set(listener.group, []);
    }
    listeners.push(listener);
  });

  const groups = [...groupTags.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, tag]) => tag);
  if (groups.length === 0) return { listeners: [], groups: [], nodes: [], skipped };

  const coreNodes = assignNodes(nodes, groups, groupMembers, skipped);

  return {
    listeners,
    groups: groups.map((tag) => ({
      tag,
      members: (groupMembers.get(tag) ?? []).map((n) => n.tag),
    })),
    nodes: coreNodes,
    skipped,
  };
}
