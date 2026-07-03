#!/usr/bin/env node
// Local smoke test for the Ethereum on-chain collector (no Cloudflare needed).
//   node scripts/test-collect-eth.mjs [--lastDay=2374]

import { collectEthereumSince } from "../src/collector.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const lastDay = parseInt(args.lastDay ?? "2374");

const records = await collectEthereumSince(lastDay);
console.log(`collected ${records.length} records since feed-day ${lastDay}`);
if (records.length) {
  console.log("first:", JSON.stringify(records[0]));
  console.log("newest:", JSON.stringify(records[records.length - 1], null, 2));
}
