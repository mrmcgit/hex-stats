#!/usr/bin/env node
// One-time backfill helper (run locally, plain Node 18+).
//
// Downloads an existing hexdailystats feed, validates + normalizes it to
// newest-first order, and writes:
//   data/fulldatapulsechain.json  (or data/fulldata.json for --chain ethereum)
//   data/meta-pulsechain.json     (collector state, pulsechain only)
//
// Upload the results to the Worker's R2 bucket with:
//   wrangler r2 object put hex-stats-feed/fulldatapulsechain.json --file data/fulldatapulsechain.json --content-type application/json --remote
//   wrangler r2 object put hex-stats-feed/meta-pulsechain.json --file data/meta-pulsechain.json --content-type application/json --remote
//
// Or, once the Worker is deployed with an ADMIN_TOKEN, skip this script and:
//   curl -X POST -H "Authorization: Bearer $TOKEN" "https://<worker>/admin/backfill?chain=pulsechain"

import { writeFile, mkdir } from "node:fs/promises";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const chain = args.chain === "ethereum" ? "ethereum" : "pulsechain";
const source =
  args.source ||
  (chain === "ethereum"
    ? "https://hexstats.today/fulldata"
    : "https://hexstats.today/fulldatapulsechain");

console.log(`Fetching ${source} ...`);
const res = await fetch(source, {
  headers: { "User-Agent": "hex-stats-backfill/1.0" },
});
if (!res.ok) {
  console.error(`Upstream returned HTTP ${res.status}`);
  process.exit(1);
}
const text = await res.text();

let records;
try {
  records = JSON.parse(text);
} catch (e) {
  console.error("Upstream response is not valid JSON:", e.message);
  process.exit(1);
}
if (!Array.isArray(records) || records.length === 0) {
  console.error("Upstream response is not a non-empty array");
  process.exit(1);
}

// Normalize to newest-first (descending currentDay).
records.sort((a, b) => (b.currentDay ?? 0) - (a.currentDay ?? 0));
const newest = records[0];
const oldest = records[records.length - 1];
console.log(
  `${records.length} records — day ${newest.currentDay} (${newest.date}) back to day ${oldest.currentDay}`
);

await mkdir("data", { recursive: true });
const feedFile = chain === "ethereum" ? "data/fulldata.json" : "data/fulldatapulsechain.json";
await writeFile(feedFile, JSON.stringify(records));
console.log(`Wrote ${feedFile}`);

if (chain === "pulsechain") {
  const meta = {
    lastDay: newest.currentDay,
    updatedAt: new Date().toISOString(),
    prev: newest,
  };
  await writeFile("data/meta-pulsechain.json", JSON.stringify(meta));
  console.log("Wrote data/meta-pulsechain.json");
}
