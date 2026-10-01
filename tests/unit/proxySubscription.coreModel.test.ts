import test from "node:test";
import assert from "node:assert/strict";

const parse = await import("../../src/lib/proxySubscription/parse.ts");
const model = await import("../../src/lib/proxySubscription/coreConfig/model.ts");
const { parseSubscription, redactedNodeSummary } = parse;
const { buildCoreModel, OWNED_TAG_PREFIX } = model;

function clashYaml(): string {
  return `proxies:
  - name: "Direct HTTP"
    type: http
    server: 1.2.3.4
    port: 8080
    username: u
    password: p
  - name: "Node A"
    type: ss
    server: 9.9.9.9
    port: 8388
  - name: "Node B"
    type: vmess
    server: 11.11.11.11
    port: 443
  - name: "Node C"
    type: vless
    server: 12.12.12.12
    port: 443
  - name: "Extra"
    type: socks5
    server: 5.6.7.8
    port: 1080
`;
}

test("duplicate node names get -2, -3 suffixes in order", () => {
  const parsed = parseSubscription(
    "vless://u@1.1.1.1:443#dup\nvless://u@2.2.2.2:443#dup\nvless://u@3.3.3.3:443#dup"
  );
  assert.equal(parsed.needsCore.length, 3);
  const m = buildCoreModel(["socks5://127.0.0.1:1080 selector=g"], parsed.needsCore);
  assert.deepEqual(
    m.nodes.map((n) => n.tag),
    ["dup", "dup-2", "dup-3"]
  );
});

test("no-suffix, valid and non-loopback entries sort into skipped vs groups", () => {
  const parsed = parseSubscription("vless://u@1.1.1.1:443#n");
  const m = buildCoreModel(
    [
      "socks5://127.0.0.1:1080",
      "socks5://127.0.0.1:1081 selector=g",
      "http://192.168.1.10:8080 selector=lan",
    ],
    [...parsed.nodes, ...parsed.needsCore]
  );
  assert.equal(m.groups.length, 1);
  assert.equal(m.groups[0].tag, `${OWNED_TAG_PREFIX}g`);
  const reasons = m.skipped.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ["invalid_endpoint", "no_selector_tag"]);
});

test("one group keeps every node, two groups split, zero groups stay empty", () => {
  const parsed = parseSubscription(
    "vless://u@example.com:443#alpha\nvless://u@example.net:443#beta"
  );
  const all = [...parsed.nodes, ...parsed.needsCore];
  const one = buildCoreModel(["socks5://127.0.0.1:1080 selector=g"], all);
  assert.equal(one.groups.length, 1);
  assert.equal(one.groups[0].members.length, 2);

  const two = buildCoreModel(
    ["socks5://127.0.0.1:1080 selector=g1", "socks5://127.0.0.1:1081 selector=g2"],
    all
  );
  assert.equal(two.groups.length, 2);
  const assigned = two.groups.flatMap((g) => g.members).sort();
  assert.deepEqual(assigned, ["alpha", "beta"]);

  const none = buildCoreModel([], all);
  assert.deepEqual(none.listeners, []);
  assert.deepEqual(none.groups, []);
  assert.deepEqual(none.nodes, []);
});

test("adding a node never moves existing assignments (hash modulo)", () => {
  const names = ["alpha", "beta", "gamma", "delta"];
  const lines = names.map((n) => `vless://u@example.com:443#${n}`).join("\n");
  const entries = [
    "socks5://127.0.0.1:1080 selector=g1",
    "socks5://127.0.0.1:1081 selector=g2",
    "socks5://127.0.0.1:1082 selector=g3",
  ];
  const before = buildCoreModel(entries, parseSubscription(lines).needsCore);
  const after = buildCoreModel(
    entries,
    parseSubscription(`${lines}\nvless://u@example.org:443#epsilon`).needsCore
  );
  const groupOf = (m: typeof before, tag: string): string | undefined =>
    m.groups.find((g) => g.members.includes(tag))?.tag;
  for (const n of names) assert.equal(groupOf(after, n), groupOf(before, n));
  // The hash actually spreads nodes across groups (a constant slot would not).
  const used = new Set(names.map((n) => groupOf(before, n)));
  assert.ok(used.size > 1, `expected spread across groups, got ${[...used]}`);
});

test("lines and clash-yaml feeds each keep their source shape", () => {
  const uri = parseSubscription("vless://u@example.com:443#alpha");
  assert.equal(uri.needsCore[0].source?.kind, "uri");
  const yaml = parseSubscription(clashYaml());
  assert.equal(yaml.nodes[0].source?.kind, "object");
  assert.equal(yaml.needsCore[0].source?.kind, "object");
});

test("redacted summary never leaks password or source", () => {
  const parsed = parseSubscription(clashYaml());
  const text = JSON.stringify(redactedNodeSummary(parsed));
  assert.ok(!text.includes('"password"'));
  assert.ok(!text.includes(" p"));
  assert.ok(!text.includes('"source"'));
});

test("end to end: clash yaml with 5 nodes builds stable groups", () => {
  const parsed = parseSubscription(clashYaml());
  assert.equal(parsed.nodes.length + parsed.needsCore.length, 5);
  const m = buildCoreModel(
    ["socks5://127.0.0.1:1080 selector=main", "http://127.0.0.1:8080 selector=web"],
    [...parsed.nodes, ...parsed.needsCore]
  );
  assert.equal(m.listeners.length, 2);
  assert.equal(m.groups.length, 2);
  assert.equal(m.nodes.length, 5);
  assert.deepEqual(m.groups.flatMap((g) => g.members).sort(), [
    "Direct HTTP",
    "Extra",
    "Node A",
    "Node B",
    "Node C",
  ]);
  // Deterministic: same input gives the same output.
  assert.deepEqual(
    buildCoreModel(
      ["socks5://127.0.0.1:1080 selector=main", "http://127.0.0.1:8080 selector=web"],
      [...parsed.nodes, ...parsed.needsCore]
    ),
    m
  );
});
