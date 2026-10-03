import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decodeGrokCredits,
  decodeGrokBilling,
  decodeGrokToken,
  grokUsage,
} from "../lib/server/grok-usage";
import { decodeMuseUsage, museUsage } from "../lib/server/muse-usage";
import { decodeAgyUsage } from "../lib/server/agy-usage";
import {
  providerCatalog,
  workerCandidates,
} from "../lib/server/provider-catalog";
import { usageJson, ProviderUsageError } from "../lib/server/usage-http";
import { defaultRoutingPreferences } from "../lib/routing-policy";

const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "crouter-provider-usage-")),
);
const originalFetch = globalThis.fetch;
const keys = [
  "CODEX_BIN",
  "CLAUDE_BIN",
  "GROK_BIN",
  "AGY_BIN",
  "MUSE_BIN",
  "CROUTER_DATA_DIR",
  "CROUTER_DEMO",
  "GROK_HOME",
  "MUSE_AUTH_PATH",
];
const env = new Map(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of env)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
after(() => rm(temp, { recursive: true, force: true }));
const grokToken = "synthetic-grok-login";
const museToken = "dca:synthetic-muse-login";
const now = Date.now();
const start = new Date(now - 60 * 60000).toISOString();
const end = new Date(now + (10080 - 60) * 60000).toISOString();
const credits = {
  config: { creditUsagePercent: 17, currentPeriod: { start, end } },
};
const museFixture = {
  is_subs_active: true,
  subs_usage: {
    window: {
      used_percent: 22,
      window_duration_mins: 300,
      resets_at: now / 1000 + 3600,
    },
    weekly: { used_percent: 44, resets_at: now / 1000 + 604800 },
  },
  key: "discarded-inference-key",
  payment_method: "discarded-payment",
};
async function logins() {
  const dir = path.join(temp, "auth");
  await mkdir(dir, { recursive: true });
  const auth = {
    "https://auth.x.ai::synthetic-client": {
      key: grokToken,
      expires_at: now / 1000 + 86400,
    },
  };
  await writeFile(path.join(dir, "auth.json"), JSON.stringify(auth), {
    mode: 0o600,
  });
  const museFile = path.join(dir, "muse.json");
  await writeFile(
    museFile,
    JSON.stringify({ providers: { meta: { access_token: museToken } } }),
    { mode: 0o600 },
  );
  process.env.GROK_HOME = dir;
  process.env.MUSE_AUTH_PATH = museFile;
  return { auth, museFile };
}
async function fakeGrok(billing?: unknown) {
  const bin = path.join(temp, billing ? "grok-rpc" : "grok-rest");
  await writeFile(
    bin,
    `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('synthetic');process.exit(0)}
if(process.argv.includes('models')){console.log('* grok-test (default)');process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const p=JSON.parse(line); if(!['initialize','x.ai/billing'].includes(p.method))process.exit(3);
if(p.method==='initialize'){ if(p.params.clientCapabilities.terminal!==false)process.exit(4);console.log(JSON.stringify({id:p.id,result:{}}));return;}
console.log(JSON.stringify(${billing ? `{id:p.id,result:${JSON.stringify(billing)}}` : "{id:p.id,error:{code:-32601,message:'Method not found'}}"}));
});`,
    { mode: 0o700 },
  );
  process.env.GROK_BIN = bin;
}
test("Grok quota preserves percentages, full billing periods and unknown readings", () => {
  const [window] = decodeGrokCredits(credits);
  assert.equal(window.usedPercent, 17);
  assert.equal(window.windowDurationMins, 10080);
  assert.equal(window.resetsAt, Date.parse(end) / 1000);
  assert.equal(
    decodeGrokCredits({ config: { creditUsagePercent: 0 } })[0].usedPercent,
    0,
  );
  assert.deepEqual(
    decodeGrokCredits({ config: { currentPeriod: { end } } }),
    [],
  );
  assert.deepEqual(
    decodeGrokCredits({
      config: { onDemandCap: { val: 0 }, onDemandUsed: { val: 0 } },
    }),
    [],
  );
  assert.equal(
    decodeGrokCredits({
      config: { onDemandCap: { val: 200 }, onDemandUsed: { val: 20 } },
    })[0].usedPercent,
    10,
  );
  assert.equal(
    decodeGrokBilling({
      monthlyLimit: { val: 100 },
      usage: { totalUsed: { val: 25 } },
    })[0].usedPercent,
    25,
  );
  assert.throws(() =>
    decodeGrokCredits({ config: { creditUsagePercent: NaN } }),
  );
  assert.equal(
    decodeGrokCredits({
      config: {
        creditUsagePercent: 10,
        currentPeriod: { start: end, end: start },
      },
    })[0].windowDurationMins,
    undefined,
  );
});
test("Grok uses metadata-only billing and falls back to the fixed saved-login endpoint", async () => {
  const { auth } = await logins();
  const authBefore = await readFile(
    path.join(process.env.GROK_HOME!, "auth.json"),
    "utf8",
  );
  await fakeGrok();
  let reads = 0;
  globalThis.fetch = async (url, init) => {
    reads++;
    assert.equal(
      url,
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${grokToken}`,
    );
    assert.equal(init?.redirect, "error");
    return Response.json(credits);
  };
  const usage = await grokUsage();
  assert.equal(usage.windows[0].usedPercent, 17);
  assert.equal(reads, 1);
  assert.equal(
    await readFile(path.join(process.env.GROK_HOME!, "auth.json"), "utf8"),
    authBefore,
  );
  assert.ok(!JSON.stringify(usage).includes(grokToken));
  assert.throws(() => decodeGrokToken(auth, now + 2 * 86400000), /expired/);
  const billing = {
    monthlyLimit: { val: 100 },
    usage: { totalUsed: { val: 25 } },
    billingCycle: { billingPeriodStart: start, billingPeriodEnd: end },
  };
  await fakeGrok(billing);
  assert.equal((await grokUsage()).windows[0].usedPercent, 25);
  assert.equal(reads, 1);
});
test("Muse quota reads only the device login and discards minted keys and billing details", async () => {
  const { museFile } = await logins();
  const before = await readFile(museFile, "utf8");
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.meta.ai/muse-code/key");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${museToken}`,
    );
    return Response.json(museFixture);
  };
  const windows = await museUsage();
  assert.deepEqual(
    windows.map((w) => w.usedPercent),
    [22, 44],
  );
  assert.deepEqual(
    windows.map((w) => w.windowDurationMins),
    [300, 10080],
  );
  assert.equal(windows[0].resetsAt, museFixture.subs_usage.window.resets_at);
  assert.ok(!JSON.stringify(windows).includes("discarded"));
  assert.equal(await readFile(museFile, "utf8"), before);
  for (const usage of [undefined, null])
    assert.throws(
      () => decodeMuseUsage({ ...museFixture, subs_usage: usage }),
      /did not include/,
    );
  assert.throws(
    () => decodeMuseUsage({ ...museFixture, is_subs_active: false }),
    /no active subscription/,
  );
  assert.throws(
    () => decodeMuseUsage({ ...museFixture, require_payment: true }),
    /billing setup/,
  );
  await writeFile(
    museFile,
    JSON.stringify({ providers: { meta: { access_token: "LLM|synthetic" } } }),
  );
  await assert.rejects(() => museUsage(), /device-code login/);
});
test("Antigravity shows measured pools without model discovery and skips disabled/unmeasured buckets", () => {
  const windows = decodeAgyUsage(
    {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              buckets: [
                { id: "gemini-5h", window: "5h", remaining_fraction: 0.8 },
                {
                  id: "3p-weekly",
                  window: "weekly",
                  remaining: { remaining_fraction: 0.4 },
                },
                { id: "gemini-weekly", disabled: true },
                { id: "gemini-unknown" },
              ],
            },
          ],
        },
      },
    },
    [],
  );
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].models, []);
  assert.equal(Math.round(windows[0].usedPercent), 20);
  assert.equal(windows[1].usedPercent, 60);
});
test("catalog displays all three provider quotas and usage gating applies to eligible models", async () => {
  await logins();
  await fakeGrok();
  process.env.CROUTER_DATA_DIR = path.join(temp, "catalog");
  process.env.CROUTER_DEMO = "0";
  for (const key of ["CODEX_BIN", "CLAUDE_BIN"])
    process.env[key] = path.join(temp, "missing");
  const muse = path.join(temp, "muse");
  await writeFile(muse, "#!/usr/bin/env node\nprocess.exit(0);", {
    mode: 0o700,
  });
  process.env.MUSE_BIN = muse;
  const agy = path.join(temp, "agy");
  const fixture = {
    status: "SUCCESS",
    num_turns: 0,
    command: {
      name: "usage",
      data: {
        groups: [
          {
            buckets: [
              { id: "gemini-5h", window: "5h", remaining_fraction: 0.8 },
            ],
          },
        ],
      },
    },
  };
  await writeFile(
    agy,
    `#!/usr/bin/env node
if(process.argv.includes('--help'))process.exit(0);
if(process.argv.includes('models'))process.exit(1);
console.log(${JSON.stringify(JSON.stringify(fixture))});`,
    { mode: 0o700 },
  );
  process.env.AGY_BIN = agy;
  let reads = 0;
  globalThis.fetch = async (url) => {
    reads++;
    return Response.json(
      String(url).includes("meta.ai") ? museFixture : credits,
    );
  };
  const rows = await providerCatalog();
  for (const id of ["grok", "muse", "agy"]) {
    const row = rows.find((p) => p.id === id)!;
    assert.ok(row.windows.length);
    assert.equal(row.usageError, undefined);
    assert.ok(row.checkedAt);
  }
  assert.ok(rows.find((p) => p.id === "agy")!.modelsError);
  assert.ok(!JSON.stringify(rows).includes(museToken));
  assert.ok(!JSON.stringify(rows).includes(grokToken));
  const preferences = {
    ...defaultRoutingPreferences,
    usageAware: true,
    enabledModels: [
      { provider: "grok" as const, model: "grok-test" },
      { provider: "muse" as const, model: "default" },
    ],
  };
  assert.deepEqual(
    workerCandidates(rows, "auto", Date.now(), preferences).map(
      (c) => c.provider,
    ),
    ["grok", "muse"],
  );
  await providerCatalog();
  assert.equal(reads, 2);
});
test("usage HTTP failures are bounded, redact responses and carry cooldowns", async () => {
  globalThis.fetch = async () =>
    new Response("sensitive server details", {
      status: 429,
      headers: { "retry-after": "120" },
    });
  await assert.rejects(
    () => usageJson("https://synthetic.invalid", {}),
    (error: unknown) =>
      error instanceof ProviderUsageError &&
      error.retryAfterMs === 120000 &&
      !error.detail.includes("sensitive"),
  );
  globalThis.fetch = async () => new Response("x".repeat(1024 * 1024 + 1));
  await assert.rejects(
    () => usageJson("https://synthetic.invalid", {}),
    /unreadable response/,
  );
});
