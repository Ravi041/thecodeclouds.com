---
title: "Caching, search and flash sales: designing for a 10x spike"
description: "How to build the CDN, Redis, search and queue layers of a shop so a flash sale doesn't take it down: cache stampedes, hot keys, overselling, search index lag and layered rate limiting, with real scenarios and five editable draw.io diagrams."
date: 2026-11-20T04:04:00Z
category: Cloud & DevOps
coverLabel: "45,000 requests\na second.\nOne flat line\non the database."
coverCode: "SET lock:deal NX PX 3000"
coverMotif: queue
coverImage: /assets/images/covers/caching-search-flash-sales.jpg
coverImageAlt: "Cloud & DevOps cover reading '45,000 requests a second. One flat line on the database.', with a queue illustration."
---
The sale opens at 12:00. At 11:58 the shop is doing its usual 4,000 requests a second. At 12:00:20 it's doing 45,000. By 12:01 the product page is timing out, the database is at 100% CPU, and somebody in the war room is asking whether we sold 8,000 consoles or 8,400.

None of that is caused by one big mistake. It's caused by a dozen small assumptions that hold on a normal day and break together under a spike: a cache that expires every key at the same second, a stock counter that two requests read at once, a search index that's thirty seconds behind, a retry loop with no jitter.

This article walks through the layers that keep a shop standing during a flash sale (CDN, cache, search, queues and rate limits) and the incidents that happen in each one. Every section starts from a real scenario, and the five diagrams are editable draw.io files you can download at the end.

<figure class="diagram wide"><a href="/assets/diagrams/caching-search-flash-sales/caching-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/caching-search-flash-sales/caching-reference.svg" alt="Reference architecture in six layers. Shoppers on the web, mobile apps, bots and partners enter at layer 1, the edge: CDN with HTML cached 30 seconds and stale-while-revalidate, WAF and bot management, edge rate limits per IP and path, and a virtual waiting room. Layer 2, the gateway: load balancer, API gateway with a token bucket per user, load shedding by priority (checkout before cart before browse before recommendations) and kill switches. Layer 3, stateless services: catalog, search, cart, inventory, checkout and orders. Layer 4, cache and search: an L1 in-process cache, a Redis cache cluster with jittered TTLs, a separate Redis for inventory with an atomic Lua reserve, and a search cluster behind a read alias. Layer 5, async: an event stream keyed by product id, an order queue with a dead-letter queue, indexer workers and order workers. Layer 6, data: primary database with orders and the inventory ledger, read replicas, outbox plus change data capture, and object storage behind the CDN. A sidebar lists what to watch during the sale (cache hit ratio, p99 and 429/503 rates, queue age, search index lag) and what to prepare before it (load test at 3x, pre-warm at T-60 minutes, game day, runbook)." width="1500" height="1000" loading="lazy"></a><figcaption>The reference architecture. Each layer absorbs load so the one below it never sees the spike.</figcaption></figure>

## The short version

- **Most requests should end at the CDN or in memory.** If a product page view reaches your database during a sale, something upstream is broken.
- **Cache expiry is a load event.** Jitter every TTL, let one caller rebuild a hot key while everyone else gets the stale value, and pre-warm the keys you know will be hot.
- **Stock is not a cache.** Reserve it with one atomic operation, keep a ledger in the database, and reconcile the two.
- **Search tells you what exists, not what it costs right now.** Take ids and facets from the index, take price and stock from the cache.
- **Queues turn a spike into a flat line.** The database should write at the rate it can sustain, not the rate shoppers click.
- **Rate limit in layers, and make clients back off with jitter.** A 429 that every client retries in the same second is just a slower outage.

## The scenario we'll use

A mid-size retailer, numbers from a real load-test plan with the names removed:

| | Normal day | Sale peak |
|---|---|---|
| Requests at the edge | 4,000/s | 45,000/s |
| Requests at the origin | 1,200/s | 9,000/s (after waiting room) |
| Redis operations | 30,000/s | 210,000/s |
| Orders written | 2/s | 1,500/s, held flat by the queue |
| Search queries | 600/s | 7,000/s |

The sale is 8,000 consoles at 40% off, opening at 12:00. Marketing has emailed 3 million people. About 1.2 million of them are on the page at 11:59, refreshing.

The traffic isn't just bigger, it's a different shape. On a normal day requests are spread across 400,000 products. During the sale, more than half of them hit the same one. That's what breaks caches that were tuned for a long tail.

## Layer 1: the edge

The cheapest request is the one that never reaches you. During a sale the CDN should answer the product page, the images, the JavaScript and the "sold out" page, and the origin should only see requests that need a decision: add to cart, reserve, pay.

### What to cache at the edge

| Content | Cache-Control | Why |
|---|---|---|
| Images, JS, CSS (hashed filenames) | `public, max-age=31536000, immutable` | Never changes, the filename does |
| Product page HTML | `public, s-maxage=30, stale-while-revalidate=60, stale-if-error=300` | 30 s old is fine; stock is loaded separately |
| Stock and price widget | `private, no-store` or a 1-2 s edge cache | Must be close to live |
| Cart, checkout, account | `private, no-store` | Per user |
| Sold-out page | `public, s-maxage=10` | Served by the edge once the flag flips |

`stale-while-revalidate` is the important part. When the 30 seconds are up, the CDN keeps serving the old page while it fetches a new one in the background, so the origin gets one request per edge location instead of a burst. `stale-if-error` means that if your origin does fall over, shoppers still see a product page instead of a 502.

The trap is putting live data into the cached page. If the HTML says "In stock: 412", you either cache it and show a wrong number, or don't cache it and send every refresh to the origin. Split the page: cache the HTML, load stock and price from a small API that's cheap to serve from Redis.

### Scenario: the CDN cache key that split into a million

A week before the sale, the team load tests and sees a 12% edge hit ratio on product pages. The pages are cacheable. The problem is the cache key: it includes the full query string, and every marketing link carries `utm_source`, `utm_campaign` and a per-recipient `utm_id`. Three million emails, three million cache keys for the same page.

The fix is to strip tracking parameters from the cache key at the edge (every CDN supports an allow-list of query parameters) and to keep cookies out of the key for cacheable pages. The hit ratio went to 97%. Check this before every sale, because someone always adds a new parameter.

### Bots, scrapers and scalpers

Sales attract automated buyers. They're fast, they don't wait on pages, and they retry instantly. At the edge you want three things:

- **WAF managed rules and bot scoring.** Block known bad bots, challenge the uncertain ones, and let verified good bots (search engines) through to cached pages only.
- **Edge rate limits.** For example, 50 requests per 10 seconds per IP on `/api/`, tighter on `/api/reserve`. Count per IP and per network (ASN), because scalpers rotate addresses inside the same hosting provider.
- **A virtual waiting room.** When the sale opens, everyone who presses Buy joins a queue and gets admitted at a rate you choose. You can buy one (Cloudflare Waiting Room, Queue-it) or build one; AWS publishes a reference solution. The admitted shopper gets a signed, short-lived token that the gateway checks.

The waiting room is the single most effective control in this whole article. It turns "1.2 million people press Buy at once" into "3,000 people a second get a fair turn", and it gives shoppers a page that says where they are in the line, which is far better than a spinner and a timeout.

## Layer 2: caching the hot path

<figure class="diagram wide"><a href="/assets/diagrams/caching-search-flash-sales/caching-stampede.svg" title="Open the full-size diagram"><img src="/assets/diagrams/caching-search-flash-sales/caching-stampede.svg" alt="Cache stampede, before and after. Before: 8,000 requests per second for the homepage deal key go through 40 app pods with no local cache to Redis, which misses on every request because every deal key had a fixed 300-second TTL, and then to the database, which receives 8,000 identical queries, hits 100% CPU and p99 latency goes from 40 ms to 4.2 seconds. After: the same requests go through app pods with a 2-second in-process L1 cache, so Redis sees about 20 requests per second. Redis finds the soft TTL passed but the hard TTL not, so it returns the value with a stale flag. One caller wins SET lock NX PX 3000 and runs a single database query, writing back with soft TTL 300 seconds, hard TTL 900 seconds and 10% jitter; the losers return the stale value. p99 stays at 45 ms. Five techniques are listed below: jittered TTL, single-flight lock, soft and hard TTL, L1 for hot keys, and pre-warming." width="1500" height="860" loading="lazy"></a><figcaption>A cache stampede and the four changes that stop it.</figcaption></figure>

Most shops use cache-aside: read from Redis, and on a miss read the database and write the result back with a TTL. It's simple and it works well for a long tail of keys. It goes wrong in three specific ways under a spike.

### Scenario: the stampede at 12:00:00

The homepage deal, the sale banner and the top 20 products were all loaded into Redis at 11:55 by a warm-up job, each with a TTL of exactly 300 seconds. At 12:00:00 they all expired in the same millisecond. Every one of the 8,000 requests a second for those keys missed, every one ran the same database query, and the database, which normally answers in 40 ms, started answering in four seconds. The slower it got, the longer the keys stayed missing, and the more requests piled in behind them.

That's a cache stampede (also called dogpiling or a thundering herd). The fix is not one trick, it's four, and they stack:

1. **Jitter the TTL.** Instead of 300 seconds, use 300 ± 10%. Keys loaded together now expire spread over a minute. This alone fixes most stampedes on the long tail.
2. **Let one caller rebuild.** On a miss, take a short lock with `SET lock:<key> <token> NX PX 3000`. Whoever gets it queries the database; everyone else waits a few milliseconds and reads again, or gets the stale value. The `PX` expiry means a pod that dies mid-rebuild doesn't hold the lock forever.
3. **Serve stale while refreshing.** Store a soft expiry inside the value and give the Redis key a longer hard TTL. After the soft expiry, the value is still there, so you return it and trigger one refresh in the background.
4. **Keep the hottest keys in process.** An in-memory cache in each pod with a 1-5 second TTL turns 8,000 Redis reads a second into about 20 (40 pods, refreshing every 2 seconds). For a price that's allowed to be 30 seconds old on the page anyway, 2 seconds is nothing.

And then the fifth, which isn't clever at all: **pre-warm the sale keys at T-10 minutes and refresh them on a schedule so they never expire during the sale.**

Here's the read path with all of it together. It's Python with `redis-py`, but the shape is the same in any language:

```python
import json, random, time, uuid

SOFT, HARD = 300, 900          # seconds

def get_product(r, local, pid):
    key = f"product:{pid}"
    if (hit := local.get(key)) is not None:            # L1, 2 s
        return hit

    raw = r.get(key)
    if raw:
        entry = json.loads(raw)
        if entry["soft_exp"] < time.time():            # stale: one caller refreshes
            refresh_async(r, key, pid)
        local.set(key, entry["value"], ttl=2)
        return entry["value"]

    return rebuild(r, local, key, pid)                 # true miss

def rebuild(r, local, key, pid):
    token = str(uuid.uuid4())
    if r.set(f"lock:{key}", token, nx=True, px=3000):  # we won
        value = db_load_product(pid)
        ttl = SOFT * random.uniform(0.9, 1.1)          # jitter
        entry = {"value": value, "soft_exp": time.time() + ttl}
        r.set(key, json.dumps(entry), ex=HARD)
        local.set(key, value, ttl=2)
        return value
    time.sleep(0.05)                                   # someone else is loading it
    return get_product(r, local, pid)
```

`refresh_async` does the same lock-then-load in the background. In production you'd cap the retry loop and fall back to the database after a few tries, but you get the idea: at most one database query per key per refresh, no matter how many requests arrive.

One warning: this lock is best effort. If two callers both rebuild the same product once in a while, nothing bad happens. Never use this pattern to protect stock or money. That needs a different tool, which is the next section.

### Scenario: one Redis shard at 100% CPU

With stampedes fixed, the next load test shows Redis cluster CPU at 30% on average, but one shard at 100% and timing out. The console's product key, its stock key and its price key all hash to the same slot, and the whole sale is hitting that one shard. Adding shards doesn't help; the hot key still lives on one of them.

The options, in the order to try them:

- **L1 cache for reads.** As above. Most hot-key problems are reads, and the in-process cache removes them from Redis entirely. Redis 6 and later can also push invalidations to clients (client-side caching with tracking), so the local copy doesn't go stale.
- **Read from replicas.** Let the read path use replicas for the hot product data. Accept that a replica can be a few milliseconds behind.
- **Split the key.** For a counter that takes a lot of writes, spread it over N keys (`stock:ps5:0` to `stock:ps5:7`) and reserve from a random one, falling back to the others when one is empty. This trades a little complexity for N times the write throughput.

### Scenario: Redis is full

At 12:03, Redis reaches `maxmemory`. The cache instance was set to `allkeys-lru`, so it starts evicting least-recently-used keys, which is what you want for a cache. But the session store and the rate-limiter keys lived in the same instance, so shoppers start getting logged out and limits reset.

Keep data you can't lose out of the cache instance. The usual split is:

| Instance | What's in it | `maxmemory-policy` |
|---|---|---|
| Cache | product, price, page fragments | `allkeys-lru` or `allkeys-lfu` |
| Inventory + rate limits | stock counters, reservations, token buckets | `noeviction` (writes fail loudly instead of keys vanishing) |
| Sessions | logged-in sessions, carts | `volatile-lru`, with TTLs on everything |

And size the cache for the sale, not the average day. Hit ratio during a sale is what you load test, so measure it there.

## Layer 3: stock, and how not to oversell

<figure class="diagram wide"><a href="/assets/diagrams/caching-search-flash-sales/caching-flash-sale.svg" title="Open the full-size diagram"><img src="/assets/diagrams/caching-search-flash-sales/caching-flash-sale.svg" alt="Flash sale request flow in ten numbered steps. 1, shoppers (1.2 million waiting at 11:59) load the sale page from the CDN. 2, pressing Buy puts them in the waiting room, which admits 3,000 shoppers per second and issues a signed token. 3, the API gateway checks the token, limits each user to 5 requests per second and sheds non-checkout traffic. 4, a stateless inventory service with 60 pods pre-scaled at 11:00. 5, Redis inventory runs a Lua script that checks and decrements stock in one atomic step. 6, the reservation goes onto an order queue that absorbs the burst, with a dead-letter queue after 5 tries. 7, 200 concurrent order workers, idempotent on order id, pull from it. 8, the primary database writes the order and the inventory ledger at a steady 1,500 writes per second. 9, the payment provider is called within its own rate limit. 10, an expiry sweeper returns stock for reservations unpaid after 10 minutes. When stock runs out, a sold-out flag is pushed to the edge and a cached sold-out page replaces the buy button. A sizing box shows 45,000 requests per second at the edge, 21,000 reaching the waiting room, 9,000 admitted, about 12,000 reserve calls per second on Redis, 1,500 database writes per second, and 8,000 units sold in 7 minutes 40 seconds with none oversold." width="1500" height="700" loading="lazy"></a><figcaption>One shopper's path through the sale. The database sees a flat line; the spike lives in the CDN, the waiting room and the queue.</figcaption></figure>

### Scenario: 8,000 consoles, 8,412 orders

This one happened in a previous sale, before any of the changes in this article. The inventory check was:

```sql
SELECT stock FROM inventory WHERE sku = 'PS5-SLIM';   -- 1
-- if stock > 0 ...
UPDATE inventory SET stock = stock - 1 WHERE sku = 'PS5-SLIM';
```

Two requests read `stock = 1` at the same moment, both decide there's one left, and both decrement. At sale traffic, "the same moment" happens hundreds of times a second. They sold 412 consoles they didn't have, and spent a week emailing apologies and refunds.

The database fix is to make the check and the decrement one statement, `UPDATE inventory SET stock = stock - 1 WHERE sku = ? AND stock >= 1`, and look at the affected row count. That's correct, but now every Buy press is a write on the same row, and row-level locking serialises them. A single hot row tops out at a few hundred to a few thousand updates a second depending on the database, and everything else waits behind it.

### Reserve in Redis, record in the database

The pattern that holds up is to split the job:

- **Redis decides, fast.** Stock for each sale SKU lives in a Redis key. A Lua script checks and decrements in one atomic step, so there's no gap between read and write. It also enforces "one per customer" in the same step.
- **The database records, steadily.** Each successful reservation goes onto a queue with an order id. Workers write the order and an inventory ledger row in one transaction, at a rate the database is comfortable with.
- **Reservations expire.** If the shopper doesn't pay within 10 minutes, a sweeper puts the unit back.

The script:

```lua
-- KEYS[1] = stock:{ps5-slim}        KEYS[2] = buyers:{ps5-slim}
-- ARGV[1] = quantity                 ARGV[2] = customer id
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then
  return -2                                   -- already bought one
end
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
if left < tonumber(ARGV[1]) then
  return -1                                   -- sold out
end
redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
return left - tonumber(ARGV[1])               -- units left after this one
```

Two details matter. The `{ps5-slim}` in braces is a hash tag: Redis Cluster puts both keys in the same slot, which a multi-key script requires. And Redis runs the whole script without interleaving other commands, so there's no window for two shoppers to take the last unit.

When the script returns `-1` for the first time, the inventory service flips a sold-out flag that the edge reads, and from then on the CDN serves a cached "sold out" page. Without that, 1.2 million people keep pressing a button that can only say no, and every press still costs you a round trip.

### Scenario: Redis failed over mid-sale

Redis replication is asynchronous. If the primary dies, the replica that's promoted can be missing the last few hundred milliseconds of writes. In a game day the team killed the inventory primary at 12:02 and found that the new primary had 37 more units in stock than had actually been sold. Without a safety net, that's 37 oversold consoles.

That's why the database ledger exists. The ledger is the truth; Redis is a fast, mostly-right copy of it. Three things close the gap:

- **Reconcile on failover.** On a failover event, pause reservations for that SKU for a few seconds, recompute `stock = initial - sum(ledger) - open reservations` from the database, and write it back to Redis.
- **Hold back a buffer.** Load 7,950 into Redis, not 8,000. The last 50 are released by the reconciler once it's sure the count is right. Shoppers never notice.
- **Make order writes idempotent.** Workers use the order id as the idempotency key, so a message that's delivered twice after a retry doesn't create two orders or two ledger rows.

You can also use Redis's `WAIT` command to make a write wait for a replica acknowledgement. It reduces the window, but it doesn't close it, so you still need the ledger.

### The queue is a shock absorber

Between Redis and the database sits a queue (SQS, Pub/Sub, Service Bus, Kafka, whatever your platform uses). It does one job: it lets 12,000 reservations a second arrive and 1,500 orders a second leave. The shopper sees "Reserved, finishing your order" immediately; the order is confirmed a second or two later.

Things to get right:

- **Fixed worker concurrency.** 200 workers, not "autoscale on queue depth". Scaling workers up just moves the spike to the database.
- **Alert on age, not depth.** A queue with 50,000 messages that drains in 30 seconds is fine. A queue with 500 messages where the oldest is 4 minutes old means workers are stuck.
- **Dead-letter after a few tries.** A poison message (bad address, payment declined in a weird way) goes to a DLQ after 5 attempts instead of blocking the queue.
- **Respect the payment provider's limits.** Your payment gateway has its own rate limit. Your workers must stay under it, or every order fails at the last step.

## Layer 4: search under load

<figure class="diagram wide"><a href="/assets/diagrams/caching-search-flash-sales/caching-search.svg" title="Open the full-size diagram"><img src="/assets/diagrams/caching-search-flash-sales/caching-search.svg" alt="Search indexing pipeline. Write path in green: 1, the catalog service saves a seller's product or price change; 2, the primary database commits the product and an outbox row in one transaction; 3, a CDC connector tails the outbox at-least-once; 4, an event stream topic product-changes keyed by product id keeps changes ordered per product; 5, indexer workers write in bulk (1,000 documents or 1 second) and skip older versions, into a search cluster where products_v7 sits behind read and write aliases. Read path in blue: 6, a shopper searches for ps5 console; 7, the search service queries the read alias and gets product ids and facets; 8, it fetches price and stock for the 24 ids on screen from Redis with MGET. Three notes: measure lag as now minus updated_at and alert at 30 seconds; reindex with zero downtime by building products_v8, backfilling, comparing and swapping the read alias atomically; and read your own writes by showing a seller their products from the database for 60 seconds after an edit." width="1500" height="700" loading="lazy"></a><figcaption>Writes reach the index through an outbox and a stream. Reads take ids from the index and live fields from the cache.</figcaption></figure>

Search (OpenSearch or Elasticsearch, usually) has a different job from the cache. It answers "which products match 'ps5 console', sorted and faceted". It's very good at that. It's not good at being the source of truth for anything that changes every second.

### Scenario: search says £299, the product page says £479

The sale price went live at 12:00. At 12:04, support has 300 tickets: the search results page shows the sale price, the product page shows the full price, or the other way round. The index is 4 minutes behind because the indexer was doing one document per request, and the sale changed prices on 6,000 products at once.

Two separate fixes:

**Make indexing fast and ordered.** Price changes go through an outbox: the catalog service writes the product change and an outbox row in the same database transaction, a change-data-capture connector (Debezium is the common one) publishes the outbox to a stream, and indexer workers consume it. Key the stream by product id so changes to one product arrive in order. Write to the index with the bulk API, 1,000 documents or 1 second, whichever comes first. And pass the database's version or `updated_at` as an external version, so if an old event is replayed after a newer one, the index ignores it.

The outbox matters because the alternative, "write to the database, then publish an event", loses the event whenever the service crashes between the two. With the outbox, the event is committed with the data or not at all.

**Don't render live fields from the index.** The search service takes product ids, titles and facets from the index, then fetches price and stock for the 24 products on screen from Redis in one `MGET`. The cache is updated directly by the write path, so it's current within a second or so. The index can be a minute behind and nobody sees a wrong price.

### Measure the lag

You can't fix what you can't see. Every event carries the `updated_at` from the database, and the indexer publishes `now - updated_at` as a metric after each bulk write. Normal is 1-3 seconds. Alert at 30 seconds; page someone at 5 minutes. Also watch consumer lag on the stream: if it's growing while workers are healthy, add partitions or raise the bulk size. Don't add retries.

### Reindex without a maintenance window

Sooner or later you change the mapping (a new analyser, a new field) and need to rebuild the index. Never reindex in place. Put the index behind two aliases, `products` for reads and `products-write` for writes, and then:

1. Create `products_v8` with the new mapping.
2. Point writes at the new index too, or replay the stream from an offset you saved before the backfill.
3. Backfill `products_v8` from the database.
4. Compare document counts and run your saved test queries against both.
5. Swap the read alias in one call.
6. Keep `products_v7` for a day so you can swap back, then delete it.

The swap is atomic, so no query ever sees a half-built index:

```http
POST /_aliases
{
  "actions": [
    { "remove": { "index": "products_v7", "alias": "products" } },
    { "add":    { "index": "products_v8", "alias": "products" } }
  ]
}
```

Don't do this during a sale. Freeze mapping changes for the week before.

### Search during the spike

Search traffic went from 600 to 7,000 queries a second, and most of them were the same five queries. Cache the results page for popular queries at the edge or in Redis for 10-30 seconds, keyed by the normalised query and filters. Add replicas ahead of the sale (replicas serve reads; primaries don't need to change). And make search a sheddable route: if the cluster is struggling, the search box can fall back to a cached "top results" page, because nobody needs search to buy the one product that's on the homepage.

## Layer 5: rate limiting and load shedding

<figure class="diagram wide"><a href="/assets/diagrams/caching-search-flash-sales/caching-rate-limits.svg" title="Open the full-size diagram"><img src="/assets/diagrams/caching-search-flash-sales/caching-rate-limits.svg" alt="Rate limiting in layers during the peak minute. 45,000 requests per second arrive (humans, bots and retries). The edge WAF and bot controls pass 21,000, with 50 requests per 10 seconds per IP and bad bot scores blocked; rejected requests get 403 or a challenge. The waiting room admits 9,000 requests per second (3,000 new shoppers per second) and shows everyone else a cached queue page. The gateway token bucket, 5 requests per second per user with a burst of 10, passes 8,400 and returns 429 with Retry-After. Service load shedding serves 7,900, dropping recommendations and reviews first and returning 503 with a fallback UI. The database pool of 400 connections takes 1,500 writes per second and the queue holds the rest. Notes explain the Redis token bucket (one key per user and route, refilled by a Lua script) and that clients must back off with exponential backoff and full jitter, capped at 3 retries." width="1500" height="800" loading="lazy"></a><figcaption>Each layer drops what the next one can't afford. Rejecting early is cheap; rejecting late costs a checkout.</figcaption></figure>

Rate limits protect you from two things: abuse, and your own success. They only work in layers, because each layer sees different information. The edge knows the IP. The gateway knows the user and the route. The service knows how busy it is right now.

### Per-user limits at the gateway

A token bucket per user and route is the usual choice: each user gets a bucket of 10 tokens that refills at 5 a second. A burst of clicks is fine; a script hammering `/reserve` isn't. Keep the buckets in the inventory Redis instance (the `noeviction` one) and update them with a short Lua script so the check and the update are one atomic round trip. Use a hash tag like `rl:{user42}:reserve` so all of one user's keys live on the same shard.

When you reject, return `429 Too Many Requests` with a `Retry-After` header. That header is not decoration. It's how you tell well-behaved clients, including your own mobile app, when to come back.

### Scenario: the retry storm at 12:00:30

The first 429s went out at 12:00:12. The mobile app's HTTP client retried failed requests three times, immediately. So every rejected request came back as four requests within a second, all rejected again. The gateway was spending most of its CPU saying no, and real shoppers' requests were queued behind the retries.

Clients have to back off, and they have to back off at different times. Exponential backoff with full jitter is the standard answer:

```python
import random, time

def call_with_retry(do_request, base=0.2, cap=5.0, attempts=3):
    for attempt in range(attempts + 1):
        resp = do_request()
        if resp.status not in (429, 503):
            return resp
        if attempt == attempts:
            return resp
        retry_after = resp.headers.get("Retry-After")
        delay = float(retry_after) if retry_after else random.uniform(0, min(cap, base * 2 ** attempt))
        time.sleep(delay)
```

The `random.uniform(0, ...)` is the important part. Without it, 10,000 clients rejected in the same second all come back in the same second. With it, they spread out. Ship this in the app before the sale, because you can't change the mobile app's retry policy at 12:00.

### Shed load by priority

When a service is overloaded, it should drop the requests that matter least first. Give every route a priority and let the gateway or the service reject the low ones when latency or concurrency crosses a threshold:

1. Checkout and payment: never shed if you can help it.
2. Reserve and cart.
3. Product pages and search.
4. Recommendations, reviews, "people also bought", live stock counters.

Pair that with kill switches: feature flags that turn off the recommendation widget or the live "412 left" counter entirely. Agree in advance who can flip them and when. During the sale in this article, turning off recommendations and reviews at 12:00 freed 15% of service capacity with no visible downside.

A concurrency limit per pod is a good backstop: if a pod is already handling 200 requests, the 201st gets a fast 503 instead of joining a queue where it'll time out anyway. A fast "no" is much better for everyone than a slow one.

## Before the sale: the checklist

Most of the work happens the week before:

- **Load test at 3x the forecast**, with the real traffic shape: one hot product, a refresh storm at 12:00, bots, and retries. A flat uniform load test will pass and tell you nothing.
- **Check the CDN cache key and hit ratio** with real marketing links.
- **Pre-scale at T-60 minutes.** Pods, Redis, search replicas, database connections. Autoscaling reacts in minutes; the spike arrives in seconds.
- **Pre-warm caches at T-10 minutes** and schedule refreshes for the sale keys so they never expire mid-sale.
- **Load stock into Redis** with the safety buffer, and run the reconciler once to prove it matches the ledger.
- **Run a game day.** Kill the Redis inventory primary, fill the order queue, make the payment provider slow. Do it in a production-like environment, not in a meeting.
- **Freeze changes** to mappings, cache code and infrastructure for 48 hours before.
- **Write the runbook**: which dashboards, which kill switches, who can flip them, and what "stop the sale" looks like.

## During the sale: what to watch

One dashboard, on the big screen in the war room:

| Signal | Healthy | Act when |
|---|---|---|
| Edge cache hit ratio | > 95% | Drops below 90% |
| Redis cache hit ratio | > 98% | Drops below 95% or a shard > 70% CPU |
| p99 latency per route | Reserve < 100 ms | Doubles for 2 minutes |
| 429 and 503 rate | Mostly at the edge | Rising at the service layer |
| Order queue oldest message age | < 5 s | > 60 s |
| Search index lag | 1-3 s | > 30 s |
| Redis stock vs ledger | Equal within open reservations | Any drift beyond that |

The last row is the one that saves you from emailing 400 people an apology.

## Download the diagrams

All five diagrams are editable draw.io files. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the numbers and names to match your shop.

- [All five diagrams in one file (5 pages)](/assets/diagrams/caching-search-flash-sales/caching-search-flash-sales.drawio)
- [Reference architecture](/assets/diagrams/caching-search-flash-sales/caching-reference.drawio)
- [Flash sale request flow](/assets/diagrams/caching-search-flash-sales/caching-flash-sale.drawio)
- [Cache stampede, before and after](/assets/diagrams/caching-search-flash-sales/caching-stampede.drawio)
- [Search indexing pipeline](/assets/diagrams/caching-search-flash-sales/caching-search.drawio)
- [Rate limiting and load shedding](/assets/diagrams/caching-search-flash-sales/caching-rate-limits.drawio)

The traffic numbers are from a load-test plan for one retailer. Yours will differ; size from your own forecast and your own load tests, and check your providers' current limits before the sale.

## References

- [Redis SET command (NX, PX options)](https://redis.io/docs/latest/commands/set/)
- [Redis key eviction policies](https://redis.io/docs/latest/develop/reference/eviction/)
- [Redis client-side caching](https://redis.io/docs/latest/develop/reference/client-side-caching/)
- [Redis EVAL command (Lua scripts)](https://redis.io/docs/latest/commands/eval/)
- [Redis WAIT command](https://redis.io/docs/latest/commands/wait/)
- [RFC 5861: HTTP Cache-Control extensions for stale content](https://www.rfc-editor.org/rfc/rfc5861)
- [OpenSearch index aliases](https://docs.opensearch.org/latest/im-plugin/index-alias/)
- [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- [Exponential backoff and jitter (AWS Architecture Blog)](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Virtual Waiting Room on AWS](https://aws.amazon.com/solutions/implementations/virtual-waiting-room-on-aws/)
- [Google SRE book: handling overload](https://sre.google/sre-book/handling-overload/)
- [Google SRE book: addressing cascading failures](https://sre.google/sre-book/addressing-cascading-failures/)
