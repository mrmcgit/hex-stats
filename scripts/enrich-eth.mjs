#!/usr/bin/env node
// One-time enrichment for gap-backfilled Ethereum records.
//
// The daily collector recovers payout/T-shares exactly for missed days, but
// supply/rate/price snapshots are only knowable "now" — so a multi-day gap
// leaves records without stakedHEX/tshareRateHEX/priceUV2UV3, which shows up
// as holes in charts. This script fills them from history:
//   - globalInfo() at each day's block via a free archive RPC (eth.drpc.org)
//   - daily eHEX close from CoinGecko's free market_chart endpoint
//
// Usage:
//   node scripts/enrich-eth.mjs                 # writes data/fulldata.json
//   npx wrangler kv key put fulldata.json --binding FEED --path data/fulldata.json --remote

import { writeFile, mkdir } from "node:fs/promises";

const FEED_URL = process.env.FEED_URL ?? "https://hexstats.chingching.xyz/fulldataethereum";
const ARCHIVE_RPC = "https://eth.drpc.org";
const HEX = "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39";
const LAUNCH = 1575331200; // 2019-12-03 00:00 UTC
const SEC_PER_BLOCK = 12.06;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, attempt = 0) {
  const res = await fetch(ARCHIVE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error || j.result === undefined) {
    if (attempt < 6) {
      const wait = 2000 * (attempt + 1);
      process.stdout.write(`  (rate limited, waiting ${wait / 1000}s)\n`);
      await sleep(wait);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 120)}`);
  }
  return j.result;
}

function words(hex) {
  const s = hex.slice(2);
  const out = [];
  for (let i = 0; i < s.length; i += 64) out.push(BigInt("0x" + s.slice(i, i + 64)));
  return out;
}

async function blockAt(targetTs, latestNum, latestTs) {
  let est = latestNum - Math.round((latestTs - targetTs) / SEC_PER_BLOCK);
  for (let i = 0; i < 3; i++) {
    const blk = await rpc("eth_getBlockByNumber", ["0x" + est.toString(16), false]);
    const drift = parseInt(blk.timestamp, 16) - targetTs;
    if (Math.abs(drift) < 60) break;
    est -= Math.round(drift / SEC_PER_BLOCK);
    await sleep(350);
  }
  return est;
}

console.log(`Fetching ${FEED_URL} ...`);
const records = await (await fetch(FEED_URL)).json();
const gaps = records.filter((r) => r._mirror && (r.stakedHEX ?? 0) === 0);
console.log(`${records.length} records, ${gaps.length} gap days to enrich:`,
  gaps.map((r) => r.currentDay).join(","));
if (gaps.length === 0) process.exit(0);

// Daily eHEX prices (UTC midnight closes) keyed by feed day.
const days = Math.min(90, Math.ceil((Date.now() / 1000 - (LAUNCH + gaps[gaps.length - 1].currentDay * 86400)) / 86400) + gaps.length + 3);
const cg = await (await fetch(
  `https://api.coingecko.com/api/v3/coins/hex/market_chart?vs_currency=usd&days=${days}&interval=daily`
)).json();
const priceByDay = {};
for (const [ms, price] of cg.prices ?? []) {
  const day = Math.round((ms / 1000 - LAUNCH) / 86400);
  priceByDay[day] = price;
}
console.log(`CoinGecko: ${(cg.prices ?? []).length} daily prices`);

const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
const latestNum = parseInt(latest.number, 16);
const latestTs = parseInt(latest.timestamp, 16);

for (const rec of gaps) {
  const day = rec.currentDay;
  const ts = LAUNCH + day * 86400; // record's day boundary (matches its date field)
  const block = await blockAt(ts, latestNum, latestTs);
  const gi = words(await rpc("eth_call", [{ to: HEX, data: "0xf04b5fa0" }, "0x" + block.toString(16)]));
  const staked = Number(gi[0]) / 1e8;
  const circulating = Number(gi[11]) / 1e8;
  const rate = Number(gi[2]) / 10;

  rec.stakedHEX = staked;
  rec.circulatingHEX = circulating;
  rec.tshareRateHEX = rate;
  rec.stakedHEXPercent = parseFloat(((staked / (staked + circulating)) * 100).toFixed(2));
  rec.penaltiesHEX = (rec.dailyPayoutHEX - ((circulating + staked) * 10000) / 100448995) * 2;
  rec.actualAPYRate = parseFloat(((rec.dailyPayoutHEX / staked) * 365.25 * 100).toFixed(2));
  const price = priceByDay[day];
  if (price) {
    rec.priceUV2UV3 = price;
    rec.tshareRateUSD = parseFloat((rate * price).toFixed(4));
    rec.marketCap = price * circulating;
    rec.totalValueLocked = price * staked;
  }
  console.log(`day ${day}: block ${block} staked=${(staked / 1e9).toFixed(2)}b rate=${rate} price=${price ?? "n/a"}`);
  await sleep(900);
}

await mkdir("data", { recursive: true });
await writeFile("data/fulldata.json", JSON.stringify(records));
console.log(`Wrote data/fulldata.json (${records.length} records). Upload with:`);
console.log("  npx wrangler kv key put fulldata.json --binding FEED --path data/fulldata.json --remote");
