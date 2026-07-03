# hex-stats

A Cloudflare Worker that mirrors the [hexstats.today](https://hexstats.today) HEX
daily-stats feed and keeps the **PulseChain** feed fresh on its own, by
collecting each newly completed HEX day directly from public subgraphs.

Built so anyone can run an independent instance for redundancy. The original
data collector is [togosh/hexdailystats](https://github.com/togosh/hexdailystats);
this project ports its PulseChain daily-stat pipeline to a serverless Worker
that fits entirely inside Cloudflare's free tier.

**Live instance:** https://hexstats.chingching.xyz/fulldatapulsechain
(also at https://hex-stats.royal-sunset-4908.workers.dev)

## Why

Many PulseChain apps consume the hexstats.today JSON feed. It is hosted by one
volunteer, so any downtime or a stalled collection job ripples into every
downstream app. This mirror:

- **Backfills** the full history from an existing feed (bytes copied verbatim)
- **Appends** each new HEX day itself from `graph.pulsechain.com` (Codeakk/Hex
  and PulseX subgraphs) plus a PulseChain RPC call, using the same formulas as
  the original collector
- **Serves** drop-in compatible endpoints with CORS

No API keys, no database server, no paid services.

## Endpoints

| Path | Description |
|---|---|
| `/fulldatapulsechain` | PulseChain daily records, newest-first (kept fresh) |
| `/fulldataethereum` | Ethereum daily records, newest-first (kept fresh) |
| `/fulldata` | legacy alias of `/fulldataethereum` (hexstats.today compatibility) |
| `/health` | per-chain `{ lastDay, updatedAt }` status |

The two chains get symmetric endpoint names on purpose — neither is the
implicit default.

## Deploy your own mirror

1. **Prereqs**: a free Cloudflare account, Node 18+, `npm i` in this repo.
2. **Create the KV namespace** (Workers KV is enabled on every account, no
   activation or card needed), then paste the printed `id` into
   `wrangler.jsonc` under `kv_namespaces`:
   ```sh
   npx wrangler kv namespace create FEED
   ```
3. **Deploy the Worker**:
   ```sh
   npx wrangler deploy
   ```
4. **Set the admin token** (guards the backfill/collect endpoints):
   ```sh
   npx wrangler secret put ADMIN_TOKEN
   ```
5. **Backfill history** from a live feed:
   ```sh
   curl -X POST -H "Authorization: Bearer <token>" \
     "https://hex-stats.<you>.workers.dev/admin/backfill?chain=pulsechain"
   ```
   (Or run `npm run backfill` locally and upload with `wrangler kv key put`,
   see `scripts/backfill.mjs` for details. Use `--source` to backfill from
   another mirror instead of hexstats.today.)
6. Done. The hourly cron appends each new day automatically. Verify with:
   ```sh
   curl https://hex-stats.<you>.workers.dev/health
   ```

## How freshness works

A cron trigger runs hourly. It asks the HEX contract for the current day
(`eth_call` on a public PulseChain RPC), then checks the Codeakk/Hex subgraph
for the latest completed `dailyDataUpdate`. When a new day has completed, it
collects supply, T-share rate, and PulseX prices, computes the derived fields
(penalties, payout per T-share, APY, staked %, T-share USD rate) with the same
formulas as upstream, and prepends the record to the stored feed.

Records collected by the mirror carry `"_mirror": true` so they are
distinguishable from backfilled upstream records.

## How Ethereum collection works

The original collector's Ethereum pipeline relied on The Graph's hosted
service, which was decommissioned (its feed froze at day 2374). This mirror
reads the HEX contract directly over public JSON-RPC instead — keyless:
`currentDay()`, `globalInfo()` and `dailyDataRange(begin, end)` provide the
payout and T-share totals for every day, so missed days backfill exactly in
a single call. The current HEX price comes from DexScreener. Note the feed's
day numbering: record N covers contract day N-1 (inherited from the original
subgraph's convention); gap-backfilled records carry the payout fields (which
drive yield math) while supply/rate/price snapshots attach to the newest
record only, matching the original collector's behavior. Records collected
here carry `"_mirror": true`.

## Costs

Free. Workers free tier (100k req/day), Workers KV free tier (1 GB storage,
100k reads/day, 1k writes/day — the mirror stores ~10 MB and writes ~2/day),
cron triggers included. The feed blob is ~5 MB; the daily append never parses
it (string prepend), so CPU stays well under limits. KV was chosen over R2
because it needs no account activation, so anyone can fork and deploy.

## License

MIT — same spirit as the upstream project.
