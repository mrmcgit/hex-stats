# hexdailystats-mirror

A Cloudflare Worker that mirrors the [hexstats.today](https://hexstats.today) HEX
daily-stats feed and keeps the **PulseChain** feed fresh on its own, by
collecting each newly completed HEX day directly from public subgraphs.

Built so anyone can run an independent instance for redundancy. The original
data collector is [togosh/hexdailystats](https://github.com/togosh/hexdailystats);
this project ports its PulseChain daily-stat pipeline to a serverless Worker
that fits entirely inside Cloudflare's free tier.

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
| `/fulldata` | Ethereum daily records (backfill only for now, see below) |
| `/health` | `{ lastDay, updatedAt }` status |

## Deploy your own mirror

1. **Prereqs**: a free Cloudflare account, Node 18+, `npm i` in this repo.
2. **Create the R2 bucket** (first 10 GB free):
   ```sh
   npx wrangler r2 bucket create hexdailystats-feed
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
     "https://hexdailystats-mirror.<you>.workers.dev/admin/backfill?chain=pulsechain"
   ```
   (Or run `npm run backfill` locally and upload with `wrangler r2 object put`,
   see `scripts/backfill.mjs` for details. Use `--source` to backfill from
   another mirror instead of hexstats.today.)
6. Done. The hourly cron appends each new day automatically. Verify with:
   ```sh
   curl https://hexdailystats-mirror.<you>.workers.dev/health
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

## Ethereum status

The original collector's Ethereum pipeline relied on The Graph's hosted
service (`api.thegraph.com`), which has been decommissioned. Reviving ETH
collection requires the decentralized Graph gateway (free API key, 100k
queries/month) and the migrated subgraph IDs. Until then, `/fulldata` serves
whatever was backfilled. Contributions welcome.

## Costs

Free. Workers free tier (100k req/day), R2 free tier (10 GB storage, no
egress fees), cron triggers included. The feed blob is ~5 MB; the daily
append never parses it (string prepend), so CPU stays well under limits.

## License

MIT — same spirit as the upstream project.
