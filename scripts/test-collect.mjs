#!/usr/bin/env node
// Local smoke test: runs the real collector against live subgraphs (no
// Cloudflare account needed) and prints the record it would append.
//
//   node scripts/test-collect.mjs            # collect latest completed day
//   node scripts/test-collect.mjs --day=2402 # collect a specific day

import { collectPulsechainDay, collectIfNewDay } from "../src/collector.js";
import { getCurrentDay, getLatestDailyData } from "../src/subgraph.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const currentDay = await getCurrentDay();
console.log(`HEX currentDay (PulseChain RPC): ${currentDay}`);

if (args.day) {
  const day = parseInt(args.day);
  const dailyData = await getLatestDailyData(day);
  if (!dailyData) throw new Error(`no dailyDataUpdate found for day <= ${day}`);
  console.log(`dailyDataUpdate: endDay=${dailyData.endDay}`);
  const record = await collectPulsechainDay(parseInt(dailyData.endDay), dailyData, null);
  console.log(JSON.stringify(record, null, 2));
} else {
  const result = await collectIfNewDay(0, null);
  if (!result) {
    console.log("collectIfNewDay returned null (no completed day found?)");
  } else {
    console.log(`Collected day ${result.day}:`);
    console.log(JSON.stringify(result.record, null, 2));
  }
}
