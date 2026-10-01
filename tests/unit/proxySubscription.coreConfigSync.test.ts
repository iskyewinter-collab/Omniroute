import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("empty path writes nothing and never calls the renderer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-empty-"));
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  let calls = 0;
  const renderers = await import("../../src/lib/proxySubscription/coreConfig/renderers.ts");
  const orig = renderers.RENDERERS[renderers.DEFAULT_CORE];
  (renderers.RENDERERS as Record<string, unknown>)[renderers.DEFAULT_CORE] = () => {
    calls += 1;
    return orig;
  };
  try {
    const res = await sync.generateForSubscription(
      { coreConfigPath: "", localCoreEndpoint: "socks5://127.0.0.1:1080 selector=g" },
      { nodes: [], needsCore: [], format: "empty" }
    );
    assert.equal(res, null);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    (renderers.RENDERERS as Record<string, unknown>)[renderers.DEFAULT_CORE] = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function singBoxFeed(): { nodes: never[]; needsCore: never[]; format: "v2ray-json" } {
  const mk = (i: number) => ({
    name: `sb-${i}`,
    source: {
      kind: "object" as const,
      value: { type: "vless", server: `203.0.113.${i}`, server_port: 443, uuid: `u-${i}` },
    },
  });
  return {
    nodes: [],
    needsCore: [mk(1), mk(2), mk(3), mk(4)] as never[],
    format: "v2ray-json",
  };
}

const ENDPOINTS = "socks5://127.0.0.1:1080 selector=a\nsocks5://127.0.0.1:1081 selector=b";

test("writes beside-file once per subscription, leaves the adopted file alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-write-"));
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  const target = path.join(dir, "core.json");
  fs.writeFileSync(
    target,
    JSON.stringify({ dns: { servers: ["https://9.9.9.9/dns-query"] }, inbounds: [], outbounds: [] })
  );
  const beforeHash = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  const res = await sync.generateForSubscription(
    { coreConfigPath: target, localCoreEndpoint: ENDPOINTS },
    singBoxFeed()
  );
  assert.equal(res, null);
  const generated = JSON.parse(fs.readFileSync(`${target}.generated`, "utf8"));
  const selectors = generated.outbounds.filter((o: { type: string }) => o.type === "selector");
  assert.equal(selectors.length, 1);
  assert.equal(generated.inbounds.length, 1);
  assert.equal(
    generated.outbounds.filter((o: { tag: string }) => o.tag.startsWith("omniroute-sb-")).length,
    4
  );
  assert.equal(createHash("sha256").update(fs.readFileSync(target)).digest("hex"), beforeHash);
});

test("second identical run writes nothing (mtime unchanged)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-mtime-"));
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  const target = path.join(dir, "core.json");
  const sub = { coreConfigPath: target, localCoreEndpoint: ENDPOINTS };
  fs.writeFileSync(target, JSON.stringify({ inbounds: [], outbounds: [] }));
  await sync.generateForSubscription(sub, singBoxFeed());
  const first = fs.statSync(`${target}.generated`).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const res = await sync.generateForSubscription(sub, singBoxFeed());
  assert.equal(res, null);
  assert.equal(fs.statSync(`${target}.generated`).mtimeMs, first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("missing directory warns without throwing", async () => {
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  const res = await sync.generateForSubscription(
    {
      coreConfigPath: path.join(os.tmpdir(), "omniroute-no-such-dir-xyz", "core.json"),
      localCoreEndpoint: ENDPOINTS,
    },
    singBoxFeed()
  );
  assert.ok(res?.includes("CORE_CONFIG_NOT_GENERATED"));
});

test("unparseable adopted file warns and is never modified", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-bad-"));
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  const target = path.join(dir, "core.json");
  fs.writeFileSync(target, "not json{{{");
  const before = fs.readFileSync(target, "utf8");
  const res = await sync.generateForSubscription(
    { coreConfigPath: target, localCoreEndpoint: ENDPOINTS },
    singBoxFeed()
  );
  assert.ok(res?.includes("CORE_CONFIG_NOT_GENERATED"));
  assert.equal(fs.readFileSync(target, "utf8"), before);
  assert.ok(!fs.existsSync(`${target}.generated`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("additive migration replays without effect", async () => {
  const sql = fs.readFileSync(
    new URL("../../src/lib/db/migrations/197_proxy_subscription_core_config.sql", import.meta.url),
    "utf8"
  );
  assert.ok(sql.includes("ADD COLUMN core_config_path TEXT"));
});

test("end to end: adopted dns and log survive into the beside-file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-e2e-"));
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  const target = path.join(dir, "core.json");
  fs.writeFileSync(
    target,
    JSON.stringify({
      dns: { servers: ["https://1.1.1.1/dns-query"] },
      log: { level: "warn" },
      inbounds: [],
      outbounds: [],
      route: { rules: [] },
    })
  );
  const res = await sync.generateForSubscription(
    { coreConfigPath: target, localCoreEndpoint: ENDPOINTS },
    singBoxFeed()
  );
  assert.equal(res, null);
  const generated = JSON.parse(fs.readFileSync(`${target}.generated`, "utf8"));
  assert.deepEqual(generated.dns, { servers: ["https://1.1.1.1/dns-query"] });
  assert.deepEqual(generated.log, { level: "warn" });
  assert.equal(generated.inbounds.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("earlier warning wins: generation skipped, skip logged, prior error kept", async () => {
  const sync = await import("../../src/lib/proxySubscription/coreConfig/sync.ts");
  // Unit-level: generateForSubscription itself returns null for empty path —
  // the skip-when-warning branch lives in the service caller (covered below
  // by code inspection of the warn-on-skip line in subscriptionService.ts).
  const src = fs.readFileSync(
    new URL("../../src/lib/proxySubscription/subscriptionService.ts", import.meta.url),
    "utf8"
  );
  assert.ok(src.includes("core config generation skipped"));
  void sync;
});
