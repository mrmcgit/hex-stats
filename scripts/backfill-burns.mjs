#!/usr/bin/env node
// One-time backfill of PulseChain burn history (run locally, plain Node 18+).
//
// Writes data/burns.json: one row per UTC day, newest-first, matching the shape
// the Worker serves at /burns.
//
//   { date: "2026-08-10", plsx: <tokens burned that day>, pls: <tokens burned>,
//     plsEstimated: true }
//
// Upload with:
//   wrangler kv key put burns.json --binding FEED --path data/burns.json --remote
//
// TWO DIFFERENT JOBS, because the two burns are nothing alike.
//
// PLSX is burned by transfer to the zero address, which reduces supply. Those are
// Transfer logs and can be totalled exactly. Note this is NOT the dead-address
// balance: 0xdEaD holds ~7.3B PLSX in total while 0x0 takes ~29M in a single
// afternoon, so reading balanceOf would have been wrong by orders of magnitude.
//
// PLS is burned as EIP-1559 base fee, which is not an event at all. Every block
// carries burnt_fees = baseFeePerGas * gasUsed, but there are ~27M blocks and no
// aggregate anywhere: PulseChain's Blockscout exposes gas prices and a cumulative
// total_gas_used, and its only charts are market and transactions. Walking every
// block is not viable, so each day is SAMPLED and scaled. Rows carry
// plsEstimated: true and the app must say so.
//
// Constraints found the hard way, both undocumented:
//   * eth_getLogs silently truncates its response above roughly 400 logs, returning
//     half-written JSON rather than an error. Chunks stay well under that, and a
//     parse failure is treated as "range too big" and retried split in half.
//   * The public RPC is not an archive node, so nothing historical can be read
//     from state. Everything here comes from logs and block headers.

import { writeFile, mkdir, readFile } from "node:fs/promises";

const RPC = "https://rpc.pulsechain.com";
const SCAN = "https://api.scan.pulsechain.com";
const PLSX = "0x95b303987a60c71504d99aa1b13b4da07b0790ab";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);

// Well under the ~400-log truncation ceiling at observed burn density.
const MAX_CHUNK_BLOCKS = 4000;
// Blocks sampled per day for the PLS base-fee estimate. Gas usage is smooth over
// a day, so a handful spread across it tracks the daily total closely; more
// samples cost a request each across ~1,200 days.
const PLS_SAMPLES_PER_DAY = 8;
const CONCURRENCY = 8;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const SCAN_HEADERS = {
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  "User-Agent": "hex-stats-backfill/1.0",
  Accept: "application/json",
};

let rpcCalls = 0;

async function rpc(method, params, { allowTruncated = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      rpcCalls++;
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // The truncation signature: a body that starts valid and simply stops.
        if (allowTruncated) return { truncated: true };
        throw new Error("unparseable RPC response");
      }
      if (body.error) throw new Error(body.error.message ?? "rpc error");
      return body.result;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(400 * (attempt + 1));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + n.toString(16);

/// Run `worker` over `items` with a fixed number of workers in flight.
async function pooled(items, worker, onProgress) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
        if (onProgress && ++done % 25 === 0) onProgress(done, items.length);
      }
    })
  );
  return out;
}

/// First block at or after a UTC timestamp, via Blockscout's index.
async function blockAtTime(unix) {
  const url = `${SCAN}/api?module=block&action=getblocknobytime&timestamp=${unix}&closest=after`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: SCAN_HEADERS });
      const body = await res.json();
      const n = Number(body?.result?.blockNumber);
      if (Number.isFinite(n)) return n;
      throw new Error(`no blockNumber: ${JSON.stringify(body).slice(0, 120)}`);
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

/// Total PLSX burned in a block range, summing Transfer(_, 0x0) values.
/// Splits and retries on the truncation signature rather than trusting a size.
async function plsxBurnedInRange(from, to) {
  if (from > to) return 0n;
  const span = to - from + 1;
  if (span > MAX_CHUNK_BLOCKS) {
    const mid = from + Math.floor(span / 2) - 1;
    const [a, b] = await Promise.all([plsxBurnedInRange(from, mid), plsxBurnedInRange(mid + 1, to)]);
    return a + b;
  }
  const result = await rpc(
    "eth_getLogs",
    [{ fromBlock: hex(from), toBlock: hex(to), address: PLSX, topics: [TRANSFER_TOPIC, null, ZERO_TOPIC] }],
    { allowTruncated: true }
  );
  if (result?.truncated) {
    if (span <= 1) throw new Error(`single block ${from} truncates; cannot split further`);
    const mid = from + Math.floor(span / 2) - 1;
    const [a, b] = await Promise.all([plsxBurnedInRange(from, mid), plsxBurnedInRange(mid + 1, to)]);
    return a + b;
  }
  return (result ?? []).reduce((sum, log) => sum + BigInt(log.data), 0n);
}

/// Estimated PLS burned across a block range, from sampled base fee x gas used.
async function plsBurnedEstimate(from, to) {
  const span = to - from + 1;
  if (span <= 0) return 0;
  const step = Math.max(1, Math.floor(span / PLS_SAMPLES_PER_DAY));
  const samples = [];
  for (let b = from; b <= to && samples.length < PLS_SAMPLES_PER_DAY; b += step) samples.push(b);

  let total = 0;
  let counted = 0;
  for (const b of samples) {
    const block = await rpc("eth_getBlockByNumber", [hex(b), false]);
    if (!block?.baseFeePerGas || !block?.gasUsed) continue;
    total += Number(BigInt(block.baseFeePerGas) * BigInt(block.gasUsed)) / 1e18;
    counted++;
  }
  if (!counted) return 0;
  return (total / counted) * span;
}

// ---------------------------------------------------------------------------

const DAY = 86400;
const startDate = args.from ?? "2023-05-13"; // PulseChain launch
const endUnix = Math.floor(Date.now() / 1000 / DAY) * DAY; // today's UTC midnight
let cursor = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);

const days = [];
for (let t = cursor; t < endUnix; t += DAY) days.push(t);
console.log(`Backfilling ${days.length} days from ${startDate} (UTC).`);

// Day boundaries first: one indexed lookup per day, so every log in a chunk
// provably belongs to that day and no block timestamps need fetching later.
console.log("Resolving day boundaries...");
const boundaries = await pooled(
  [...days, endUnix],
  (t) => blockAtTime(t),
  (d, n) => process.stdout.write(`\r  ${d}/${n}`)
);
process.stdout.write("\n");

const ranges = days.map((t, i) => ({
  date: new Date(t * 1000).toISOString().slice(0, 10),
  from: boundaries[i],
  to: boundaries[i + 1] - 1,
}));

// Resume support: an interrupted run keeps whatever it already wrote.
let existing = [];
try {
  existing = JSON.parse(await readFile("data/burns.json", "utf8"));
} catch {}
const have = new Map(existing.map((r) => [r.date, r]));
const todo = ranges.filter((r) => !have.has(r.date) && r.to >= r.from);
console.log(`${have.size} days already done, ${todo.length} to fetch.`);

console.log("Fetching burns...");
const rows = await pooled(
  todo,
  async (r) => {
    const [plsxRaw, pls] = await Promise.all([
      plsxBurnedInRange(r.from, r.to),
      plsBurnedEstimate(r.from, r.to),
    ]);
    return {
      date: r.date,
      plsx: Number(plsxRaw) / 1e18,
      pls,
      plsEstimated: true,
    };
  },
  (d, n) => process.stdout.write(`\r  ${d}/${n} days  (${rpcCalls} rpc calls)`)
);
process.stdout.write("\n");

for (const row of rows) if (row) have.set(row.date, row);
const all = [...have.values()].sort((a, b) => (a.date < b.date ? 1 : -1)); // newest-first

await mkdir("data", { recursive: true });
await writeFile("data/burns.json", JSON.stringify(all));

const totalPlsx = all.reduce((s, r) => s + r.plsx, 0);
const totalPls = all.reduce((s, r) => s + r.pls, 0);
console.log(`Wrote data/burns.json — ${all.length} days, ${rpcCalls} rpc calls`);
console.log(`  PLSX burned (exact):     ${totalPlsx.toLocaleString()} `);
console.log(`  PLS burned (estimated):  ${totalPls.toLocaleString()} `);
