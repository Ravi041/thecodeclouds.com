---
title: "E-commerce on Google Cloud: a reference architecture that survives sale day"
description: "A production e-commerce architecture on Google Cloud: global load balancing with Cloud CDN and Cloud Armor, two active regions on GKE and Cloud Run, Spanner for orders and stock, Memorystore, Pub/Sub and AI Commerce Search. Walked through real scenarios: a region going down, a 30x flash sale, a hot SKU and a slow payment provider. Five editable draw.io diagrams included."
date: 2026-11-20T04:09:00Z
category: Cloud & DevOps
coverLabel: "E-commerce on\nGoogle Cloud\nthat survives\nsale day."
coverCode: "2 regions · 1 Spanner · 0 lost orders"
coverLogos: "google-cloud, kubernetes"
coverImage: /assets/images/covers/ecommerce-architecture-google-cloud.jpg
coverImageAlt: "Cloud & DevOps cover reading 'E-commerce on Google Cloud that survives sale day.', with the Google Cloud and Kubernetes logos."
---
An online store is easy to build and hard to keep running. The product pages, the cart and the checkout all work fine in a demo. Then marketing sends a push notification to two million people at 10:00 on a Saturday, a region has a bad morning on the same weekend, and the payment provider starts answering in nine seconds instead of one. Each of those on its own is survivable. What hurts is finding out on the day which parts of your design assumed none of them would happen.

This article is a reference architecture for e-commerce on Google Cloud, built around those days rather than the quiet ones. It covers what each layer is for, the checkout path in detail, and then walks through the scenarios that actually take stores down: a regional outage, a flash sale, one product everyone wants, a slow payment provider, and a few smaller ones. There are five diagrams, all editable draw.io files you can download at the end.

<figure class="diagram wide"><a href="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-reference.svg" alt="Reference architecture for e-commerce on Google Cloud. Four kinds of clients at the top: shoppers on the web, the mobile app, marketplaces and partners, and stores and the call centre. All of them enter layer 1, the global edge, which has Cloud DNS, a global external Application Load Balancer, Cloud Armor for WAF, rate limits and bot rules, and Cloud CDN for images, JavaScript and cacheable pages. Layer 2, compute, has two active regions, us-east4 and us-east1, and either one can carry the whole load. Each region has a GKE Autopilot cluster running the storefront backend, catalog, cart, checkout, orders and inventory services, Cloud Run for payment webhooks, image resizing and feeds, and Memorystore for Valkey for cart and session cache and hot SKUs. Layer 3, data, has Spanner in a multi-region configuration for orders, inventory, carts and the payment ledger, Cloud Storage dual-region for product media, Cloud SQL for PostgreSQL for the CMS, promotions and back office, and Firestore for wishlists and preferences. Layer 4, events and intelligence, has Pub/Sub for order, stock and click events, Cloud Tasks for emails and retries, Dataflow, BigQuery, and AI Commerce Search for search and recommendations. Layer 5, the landing zone, has Shared VPC with Private Service Connect, Cloud NAT with fixed egress IPs for the payment provider, IAM with Workload Identity, and Cloud KMS with Secret Manager. On the right, outside Google Cloud, are the payment provider, fraud scoring, ERP and warehouse systems, and carriers, email and SMS. An Operate column lists Cloud Monitoring SLOs, Cloud Logging and Trace, Security Command Center and Error Reporting. A note says checkout depends only on layers 1, 2 and 3 and the payment provider." width="1500" height="1040" loading="lazy"></a><figcaption>The reference architecture: one anycast IP, two active regions, one multi-region source of truth, and everything that can wait moved off the checkout path.</figcaption></figure>

## The short version

- **Design for the busiest hour, not the average one.** Peak traffic on a sale day can be 20 to 50 times a normal afternoon. Size, test and set quotas for that.
- **One global front door.** A global external Application Load Balancer gives you one anycast IP, TLS at the edge, Cloud CDN for anything cacheable and Cloud Armor for rate limits and bots, all before a request reaches your code.
- **Two active regions, each able to carry everything.** Run the app in two regions all the time. If one fails, the load balancer moves traffic on its own. A standby region you never send traffic to is a region you don't know works.
- **Orders and stock live in Spanner.** A multi-region Spanner instance commits every write to two regions, so losing a region loses no orders and needs no manual database failover.
- **Cache is a speed-up, never the truth.** Memorystore holds carts, sessions and hot product data, but every one of them can be rebuilt from Spanner. Price and stock are checked against Spanner at checkout.
- **Keep checkout short.** The synchronous path is the load balancer, the checkout service, Spanner and the payment provider. Emails, fulfilment, analytics and recommendations happen after the response, through Pub/Sub, and can lag for an hour without losing anything.
- **Make every write idempotent.** Shoppers double-click, mobile networks retry, payment webhooks arrive twice. An idempotency key per checkout attempt and a deduplicated consumer turn all of those into no-ops.
- **Keep card data out of your systems.** Use the payment provider's hosted fields or tokenisation, so your PCI DSS scope stays small.

## A note on names

Google renamed a lot in 2026. Vertex AI became **Gemini Enterprise Agent Platform** at Next in April, and Vertex AI Search for commerce became **AI Commerce Search**, part of Gemini Enterprise for Customer Experience. Recommendations still live inside it. Memorystore now offers Valkey, the open-source fork of Redis, and that's the engine I use here. Older docs, Terraform resources and API names still use the old names, so expect both for a while.

## What we're designing for

Before drawing boxes, write down the numbers. These are typical for a mid-size retailer doing a few hundred million a year online, and they drive every choice below.

| Requirement | Target | Why it matters |
| --- | --- | --- |
| Checkout availability | 99.99% per month (about 4 minutes of downtime) | A minute of failed checkout on sale day is real money |
| Orders lost in a region failure (RPO) | Zero | You can't email a customer to say their paid order vanished |
| Time to recover from a region failure (RTO) | Under 5 minutes, no human needed for traffic | Nobody wants a 2 a.m. runbook for something the platform can do |
| Normal traffic | ~2,000 requests a second | Sizing for the baseline and for cost |
| Peak traffic | ~60,000 requests a second for 10 to 20 minutes | Flash sales, TV ads, influencer posts |
| Checkout latency | p95 under 1.5 seconds, excluding 3-D Secure | Slow checkout costs conversion |
| Card data | Never stored, processed or transmitted by our servers | Keeps PCI DSS scope to the smallest questionnaire |

If your numbers are much smaller, you can drop the second region and Spanner (more on that below). If they're bigger, the shape stays the same and the quotas go up.

## The architecture, layer by layer

### 1. The global edge

Everything comes in through one **global external Application Load Balancer**. It gives you a single anycast IP announced from Google's edge locations around the world, so a shopper in Paris and a shopper in Texas both connect to a nearby Google front end, TLS is terminated there, and the request travels to your backend over Google's network. You get HTTP/2 and HTTP/3, managed certificates and URL maps for routing `/api/*`, `/checkout/*` and static paths to different backends.

Three things are attached to it:

- **Cloud CDN** caches product images, JavaScript and CSS, and also whole product and category pages if you make them cacheable. On sale day this is the most important box in the diagram: a 90% cache hit ratio means your backends see one tenth of the traffic. Use versioned URLs for assets (`app.4f9c1.js`) with a long `max-age`, and short TTLs with `stale-while-revalidate` for pages, so a price change shows up within a minute and the CDN can still serve a slightly old page while it fetches a new one.
- **Cloud Armor** sits in front of the backends with the preconfigured WAF rules (SQL injection, XSS and friends), rate-limiting rules per IP or per session cookie, and bot rules. On checkout and login, add reCAPTCHA action tokens so Cloud Armor can tell a person from a script. Adaptive Protection, part of Cloud Armor Enterprise, learns your normal traffic and suggests rules when something looks like an attack.
- **Backend buckets** in Cloud Storage serve product media directly, so image traffic never touches your compute at all.

**Cloud DNS** holds the zone with DNSSEC on. Its only job here is to point the store's name at the load balancer's IP, which never changes, so DNS TTLs don't matter during a failover.

### 2. Compute: two active regions

The application runs in two regions, here `us-east4` and `us-east1`, chosen to match the Spanner configuration below. Both serve traffic all the time. The load balancer sends each shopper to the nearest healthy region, and if a region stops passing health checks it simply stops getting traffic.

Each region has a **GKE Autopilot** cluster with the core services: the storefront backend (the BFF that the web and app call), catalog, cart, checkout, orders and inventory. Autopilot means Google manages nodes; you pay per pod resource request and don't size node pools. The two clusters are registered to a fleet and exposed through a **multi-cluster Gateway** (the `gke-l7-global-external-managed-mc` GatewayClass), so one Gateway resource programs one global load balancer with both clusters behind it.

**Cloud Run** handles the spiky, stateless edges: the payment provider's webhooks, image resizing, product feed generation for marketplaces, and the event collector for clickstream. It scales from zero to thousands of instances and back without you touching anything.

How to choose between them for a given service:

| Use GKE Autopilot when | Use Cloud Run when |
| --- | --- |
| The service is always busy and part of the core path | Traffic is bursty or near zero at night |
| You need service mesh, sidecars or custom networking | It's a single container answering HTTP or events |
| You want tight control of rollout, PodDisruptionBudgets, affinity | You want the least operational work possible |
| You run many services that call each other | It's an integration edge: webhooks, feeds, collectors |

There's no wrong answer for many services. The rule I use: the checkout path goes where your team is most practised at debugging at 3 a.m.

**Memorystore for Valkey** runs in each region for carts, sessions, rate-limit counters and hot catalog data. It's configured with cross-region replication so the other region has a warm copy if you need it. But nothing in it is the only copy of anything.

### 3. Data: one source of truth that survives a region

This is the layer that decides whether a regional outage loses orders.

**Spanner** holds orders, payments, stock and carts. The instance uses the `nam3` multi-region configuration: read-write replicas in `us-east4` (the default leader region) and `us-east1`, and a witness replica in `us-central1`. Every commit needs a majority of voting replicas, which spans at least two regions, so an acknowledged write is already in two places. If the leader region fails, Spanner moves leadership to the other read-write region on its own. Multi-region Spanner is designed for 99.999% availability, and it's the reason the region failure scenario below needs no database runbook.

Do you need Spanner? Not always. Here's the honest comparison for the order and stock database:

| | Cloud SQL for PostgreSQL | Spanner (multi-region) |
| --- | --- | --- |
| Writes | One primary in one region | Any region, committed to two regions |
| Region failure | Promote a cross-region replica: minutes of downtime, possible loss of the last few seconds of writes | Automatic, no data loss for committed writes |
| Scale | Vertical, up to one big machine, plus read replicas | Horizontal, add compute capacity, no sharding in your code |
| SQL | Full PostgreSQL, extensions, the tools you know | GoogleSQL or PostgreSQL dialect, some differences, schema design matters more |
| Cost at small scale | Low | Higher; editions and autoscaling help, but there's a floor |
| Good fit | One region is acceptable, under a few thousand writes a second | Multi-region writes, zero RPO, or a write rate that outgrows one machine |

Many stores should start with Cloud SQL with high availability in one region and a cross-region replica, and move the order and stock tables to Spanner when the numbers in the requirements table become real. In this architecture **Cloud SQL** still has a job: the CMS, promotions engine and back-office tools that don't need multi-region writes and benefit from plain PostgreSQL.

**Cloud Storage** in a dual-region bucket holds product media and exports. **Firestore** holds wishlists and user preferences, which are per-user documents that don't need joins or the same consistency as orders.

### 4. Events and intelligence

Everything that doesn't need to happen before you tell the shopper "order placed" moves off the synchronous path.

- **Pub/Sub** carries order events, stock changes and clickstream. It's a global service, so publishers in either region keep working when one fails. Every subscriber gets its own subscription with a dead-letter topic.
- **Cloud Tasks** handles work that must happen once, at a controlled rate, with retries: the receipt email, calls to a carrier API that allows 10 requests a second, the push notification.
- **Dataflow** streams events into **BigQuery** for analytics, funnels and demand.
- **AI Commerce Search** powers site search and recommendations, trained on your catalog and the user events you send it.

### 5. The landing zone

The usual guardrails, with a few e-commerce specifics:

- **Shared VPC with Private Service Connect** so GKE and Cloud Run reach Spanner, Memorystore and Google APIs without public IPs. If you're building the network from scratch, the [hub-and-spoke design](/blog/gcp-hub-and-spoke-networking/) covers it.
- **Cloud NAT with reserved static IPs** in both regions. Payment providers and some ERPs allow-list your egress IPs, and both regions' addresses have to be on that list before the day you need them.
- **Workload Identity**, one Google service account per service, no keys. The checkout service can write orders; the recommendations service can't.
- **Cloud KMS** for CMEK on Spanner, Cloud Storage and BigQuery, and **Secret Manager** for the payment provider's API keys and webhook signing secret. There's more on how CMEK works in [KMS envelope encryption](/blog/cloud-kms-envelope-encryption/).
- **PCI DSS scope:** with hosted payment fields, card numbers go from the shopper's browser straight to the payment provider. Your servers only ever see a token. That's the single biggest decision for your compliance workload, and it's made in the frontend, not in the cloud.

All of it should be Terraform. The [Terraform on Google Cloud guide](/blog/terraform-google-cloud-enterprise-guide/) covers how to structure the projects and state.

## Checkout, step by step

Checkout is the only part of the store where a bug costs money directly, so it's worth walking through every step.

<figure class="diagram wide"><a href="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-checkout.svg" title="Open the full-size diagram"><img src="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-checkout.svg" alt="Checkout request path on Google Cloud with nine numbered steps. 1: the shopper posts the order with an idempotency key. 2: the global external Application Load Balancer with Cloud Armor routes to the nearest healthy region. 3: the checkout service on GKE Autopilot in us-east4 reads the cart snapshot from Memorystore for Valkey. 4: it runs a Spanner read-write transaction on the nam3 instance that holds stock, inserts the order as pending and writes an outbox row. 5: it calls fraud scoring and then the payment provider through Cloud NAT with fixed egress IPs, reusing the idempotency key. 6: a second Spanner transaction marks the order authorised and the shopper gets a response. 7: the payment provider's webhook lands on a Cloud Run service that verifies the signature and upserts the payment state into Spanner. 8: an outbox relay or Spanner change stream publishes events to a Pub/Sub topic called order-events. 9: subscribers for fulfilment on Cloud Run, notifications via Cloud Tasks, analytics into BigQuery and purchase events for AI Commerce Search consume the events. Cloud Scheduler releases expired stock holds in Spanner." width="1500" height="1060" loading="lazy"></a><figcaption>The checkout path. Steps 1 to 6 sit on the shopper's click; 7 to 9 happen afterwards and can retry for hours.</figcaption></figure>

### Hold stock, create the order and record the event in one transaction

The core of checkout is one Spanner read-write transaction that does three things together: hold the stock, create the order in `PENDING`, and write an outbox row describing what happened. Because it's one transaction, you never get an order without a stock hold, or a stock hold without an order, or an order that never produces an event.

A simplified schema:

```sql
CREATE TABLE orders (
  order_id        STRING(36) NOT NULL,      -- UUIDv4, never a timestamp
  customer_id     STRING(36),
  idempotency_key STRING(64) NOT NULL,
  status          STRING(20) NOT NULL,      -- PENDING, AUTHORISED, PAID, CANCELLED
  total_minor     INT64 NOT NULL,           -- money in minor units, never FLOAT
  currency        STRING(3) NOT NULL,
  created_at      TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (order_id);

CREATE UNIQUE INDEX orders_by_idem ON orders (idempotency_key);

CREATE TABLE stock_reservations (
  sku        STRING(40) NOT NULL,
  order_id   STRING(36) NOT NULL,
  qty        INT64 NOT NULL,
  expires_at TIMESTAMP NOT NULL,
) PRIMARY KEY (sku, order_id);

CREATE TABLE outbox (
  event_id   STRING(36) NOT NULL,
  topic      STRING(60) NOT NULL,
  payload    JSON NOT NULL,
  created_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (event_id);
```

The unique index on `idempotency_key` is what makes a double click harmless. The browser generates one key per checkout attempt and sends it on every retry. The second request either finds the existing order and returns it, or fails on the unique index and then reads the existing order. Either way the shopper gets one order.

### Talk to the payment provider carefully

The call to the payment provider is the riskiest step, because it's the only one that leaves your control. Four rules:

1. **Pass your idempotency key to the provider.** Most providers accept one. If your request times out and you retry, the provider returns the original result instead of charging twice.
2. **Set a timeout and don't retry blindly.** A timeout means "unknown", not "failed". Mark the order `PAYMENT_PENDING` and let the webhook or a reconciliation job settle it.
3. **Treat the webhook as the source of truth for payment state.** The Cloud Run handler verifies the signature, then upserts by the provider's payment reference, so a webhook that arrives twice, or before your own response, ends in the same state.
4. **Reconcile daily.** A job compares the provider's settlement report with your orders table and flags anything that doesn't match. There's always something.

### Publish events after the commit, never before

Don't publish to Pub/Sub inside the checkout request. If the publish succeeds and the transaction then aborts, downstream systems ship an order that doesn't exist. If the transaction commits and the publish fails, they never hear about one that does. The outbox row is committed with the order, and a small relay (or a Spanner change stream on the outbox table) publishes it afterwards. Consumers use `event_id` to drop duplicates, because the relay guarantees at-least-once, not exactly-once.

### Release stock that was held but never paid for

A shopper who abandons checkout at the 3-D Secure screen is still holding stock. A Cloud Scheduler job runs every minute and releases reservations past `expires_at` whose order isn't paid. Don't use a Spanner TTL policy for this: TTL is for cleanup and deletes rows in the background some time after they expire, typically within days, not at the minute you need.

## Scenario 1: a region goes down during trading

It's 11:02 on a Saturday and `us-east4` starts failing. Maybe it's a zonal problem that spreads, maybe it's a bad config push to that region's cluster. It doesn't matter much why. What matters is what the shopper sees.

<figure class="diagram wide"><a href="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-region-failure.svg" title="Open the full-size diagram"><img src="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-region-failure.svg" alt="Regional failure scenario. Shoppers keep using the same URL and IP. The global external Application Load Balancer with Cloud Armor and Cloud CDN health-checks backends every 5 seconds and uses outlier detection on 5xx responses. Region us-east4 is marked unavailable: GKE Autopilot backends are unhealthy, Cloud Run gets no traffic and the Valkey primary is lost. The load balancer sends 0% there after about 30 seconds and 100% of traffic to region us-east1, where GKE Autopilot scales from 40 to 90 pods, Cloud Run scales on requests and the Valkey secondary, kept warm by cross-region replication, is promoted to primary. Region us-east1 normally runs at about 50% CPU so it can absorb the extra load before new nodes arrive. Below, the Spanner nam3 instance has read-write replicas in us-east4, which was the default leader and is now lost, and us-east1, which becomes leader automatically, plus a witness in us-central1 that keeps quorum. Writes keep committing and committed orders are not lost. Pub/Sub, dual-region Cloud Storage, Cloud DNS and Artifact Registry are global or multi-region and keep working. A timeline on the right runs from 11:02:00 when the error rate jumps to 11:06:00 when the SLO alert closes, and lists what made the failover uneventful." width="1500" height="1000" loading="lazy"></a><figcaption>A region failure that shoppers barely notice: the load balancer moves traffic, Spanner moves leadership, and the only manual step is promoting the cache.</figcaption></figure>

Here's what happens, and what had to be in place for it to happen that way:

**Traffic moves in about 30 seconds, by itself.** The backend services have health checks every 5 seconds and **outlier detection** on 5xx responses, so failing endpoints are ejected even before the health checks agree. Once a region's backends are unhealthy, the global load balancer sends everything to the other region. No DNS change, no human. The shopper's next request just goes somewhere else.

**The surviving region has room.** This is the part people skip. If each region runs at 80% on a normal Saturday, the survivor needs 160% the moment the other one fails, and Autopilot takes a minute or two to bring up new nodes. Run each region at about 50% of what it can do at the time of day you care about, keep a little spare capacity with low-priority placeholder pods that real pods can evict, and set HPA `maxReplicas` high enough for the whole load. That's the price of active-active. It's cheaper than an outage.

**Orders keep committing.** Spanner loses its default leader region and moves leadership to `us-east1` automatically. Writes need a quorum, which `us-east1` and the witness in `us-central1` still provide. You'll see a short latency bump; you won't lose a committed order and you don't run a database failover.

**In-flight checkouts retry safely.** Some requests were mid-checkout in `us-east4` when it died. The client retries with the same idempotency key, lands in `us-east1`, and either finds the order already committed or creates it once.

**The cache is the one manual step.** The Valkey secondary in `us-east1` has been replicating from the primary. Promote it using the runbook. Until you do, or for keys that didn't replicate, the cart service misses cache and rebuilds carts from Spanner. That's slower, not broken, which is why carts live in Spanner and the cache only holds copies.

**Check the boring dependencies.** In real incidents the thing that breaks is rarely the main app. It's the payment provider rejecting calls from the other region's NAT IPs because only one set was allow-listed, or an image pulled from a regional registry, or a secret that only existed in one region. Make a list of every regional dependency and test it.

**Practice it.** Once a quarter, on a quiet weekday morning, drain one region on purpose by removing it from the Gateway and watch what happens. The first time you do this you'll find at least one of the problems above.

## Scenario 2: a flash sale sends 30x normal traffic

The marketing team has a 10:00 sale on a games console. At 09:59 the site is doing 2,000 requests a second. At 10:00:30 it's doing 60,000, and a good share of those are bots.

<figure class="diagram wide"><a href="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-flash-sale.svg" title="Open the full-size diagram"><img src="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-flash-sale.svg" alt="Flash sale scenario. A left-to-right chain shows shoppers and bots at 60,000 requests a second, then Cloud CDN with product and sale pages cached, Cloud Armor with rate limits, bot rules and WAF, a waiting room on Cloud Run with admission tokens in Valkey, GKE Autopilot with a pre-scaled storefront and checkout, Spanner with sharded stock counters, Pub/Sub as an order-events buffer and fulfilment and email consuming at their own pace. A bar chart below shows illustrative requests per second reaching each layer: 60,000, 60,000, 7,000 after 90% cache hits, 5,600 after bots are dropped, 2,500 admitted, 900 Spanner writes, 300 orders and 300 smoothed. A panel titled Before 10:00 lists load testing at 1.5 times the forecast, raising quotas, pre-scaling HPA and Spanner, warming the CDN, freezing deploys and running Cloud Armor rules in preview first. A panel titled During the spike lists admitting at the rate checkout can take, holding stock with a TTL, responding after the Spanner commit, shedding non-essential features, watching checkout success rate and p95, and queuing payment calls if the provider slows down. A bottom section explains the hot SKU problem, where one stock row for a TV gets locked by every checkout, and the fix of splitting the counter into 10 shards of 50 units, plus alternatives: reservation tokens in a Valkey list, batch allocation by one worker per SKU, and using UUIDv4 or bit-reversed sequences for order IDs." width="1500" height="1040" loading="lazy"></a><figcaption>Each layer's job is to make sure the next one sees less traffic. Spanner and the payment provider should see a steady stream, not the spike.</figcaption></figure>

Most of the work happens before 10:00.

**Load test at 1.5x the forecast, a week before.** Same code version, a database with a realistic amount of data, traffic from outside Google Cloud through the real load balancer. The goal isn't a pass mark, it's finding the first thing that breaks. It's usually a quota, a connection pool or one slow query.

**Raise quotas early.** GKE node and IP quotas, Cloud Run maximum instances, Spanner compute capacity, Pub/Sub throughput. Quota increases can take days, and on the morning of the sale they're the one thing you can't fix by working faster.

**Pre-scale instead of hoping autoscaling is fast enough.** Autoscaling reacts to load that has already arrived. Raise HPA `minReplicas` at 09:30 and lower it at noon, with a CronJob or your deploy pipeline. If you use the Spanner managed autoscaler, raise its minimum before the sale for the same reason. Your scale-up should be finished before the first push notification goes out.

**Warm the CDN.** Request every sale page and every product image once before 10:00. A cold cache at 10:00:00 means the first wave goes straight to your backends at the worst moment, and many shoppers request the same uncached page at once.

**Rate-limit with Cloud Armor, and test the rules in preview first.** A throttle rule on the checkout path, keyed on IP (or on a session cookie if lots of real shoppers share mobile carrier IPs):

```bash
gcloud compute security-policies rules create 1000 \
  --security-policy=shop-edge \
  --expression="request.path.startsWith('/api/checkout')" \
  --action=throttle \
  --rate-limit-threshold-count=20 \
  --rate-limit-threshold-interval-sec=60 \
  --conform-action=allow \
  --exceed-action=deny-429 \
  --enforce-on-key=IP \
  --preview
```

Run it with `--preview` for a few days, read the logs to see who would have been blocked, then remove `--preview`. Enabling a new rate limit for the first time on sale morning is how you block your own customers.

**Use a waiting room.** When demand is bigger than what checkout can handle, it's kinder and safer to make people wait in a queue than to let everyone in and fail half of them. A small Cloud Run service hands out signed admission tokens at the rate checkout can take, and the storefront only lets you into checkout with a valid token. The counter lives in Valkey. Shoppers see a "you're in the queue" page served from the CDN instead of an error.

**Respond after the commit, do the rest later.** At peak, checkout does the Spanner transaction and the payment authorisation and stops. Fulfilment, email and analytics pick up events from Pub/Sub at the rate they can, which is why the right-hand bars in the diagram are flat.

**Shed what you can.** Have feature flags ready to turn off reviews, recommendations, "people also bought" and wishlists. They're nice to have, and each one is a call that can slow a product page down at the worst time.

## Scenario 3: everyone wants the same product

The flash sale has a second problem hiding in it. If 5,000 people try to buy the same TV in the same second, and stock is one row with `qty = 500`, every checkout transaction needs a lock on that one row. Transactions queue, abort and retry, latency climbs, and throughput stops at whatever a single row can do, regardless of how much capacity the database has.

The fix is to stop having one row:

- **Sharded counters.** Split the stock into, say, 10 rows of 50 each (`stock_shards (sku, shard_id, qty)`). Each checkout picks a shard at random, or by a hash of the shopper's ID, and decrements it. If it's empty, try another. Total available stock is the sum of the shards. Contention drops by roughly the number of shards.
- **Reservation tokens.** Before the sale, push 500 tokens into a Valkey list for that SKU. Each shopper pops one with `LPOP`; no token, no checkout, and the "sold out" page is instant. The order still commits to Spanner, which stays the source of truth. If the cache fails and loses tokens, you sell a few units later than you could have, but you never sell one twice.
- **Batch allocation.** Checkout writes a reservation request; one worker per hot SKU allocates requests in order, in batches. It's slower to respond but very fair, and it's the right answer for limited releases where people care about who was first.

The same idea applies to keys. If order IDs are timestamps or come from a plain incrementing counter, every new order goes to the end of the table and you get a write hotspot there too. Use UUIDv4 or Spanner's bit-reversed sequences.

## Scenario 4: the payment provider slows down

At 14:20 the provider's p95 goes from 800 ms to 9 seconds. Nothing is down, it's just slow. This is worse than an outage in one way: requests pile up, every checkout pod has hundreds of open connections waiting, and soon your own service is the thing timing out.

What helps:

- **A tight timeout on the call** (8 seconds is plenty for most providers, outside of 3-D Secure flows which happen in the browser) and a **circuit breaker** that opens when the error or timeout rate passes a threshold.
- **Bulkheads.** A separate connection pool for the payment provider, so slow payment calls can't use up the connections the cart and catalog need.
- **A graceful degraded mode.** When the breaker is open, accept the order as `PAYMENT_PENDING`, tell the shopper "we've got your order, you'll get a confirmation email shortly", and let a Cloud Tasks queue retry the authorisation at a controlled rate. Not every business can take that risk on every order, so agree the rules with finance in advance, not during the incident.
- **A second provider** if your volume justifies it, behind the same interface, with routing you can change with a flag.

## Scenario 5: smaller things that still ruin a Saturday

**The cache flush.** Someone flushes Valkey, or a deploy changes the cache key format, and every product page misses at once. Thousands of requests hit Spanner for the same 200 popular products. Protect against this with request coalescing (one request fetches, the others wait for it), jittered TTLs so keys don't expire together, and a cache warm-up step in the deploy pipeline. Cloud CDN already coalesces requests for the same uncached URL at the edge, which helps for pages but not for API calls.

**The bad catalog import.** A supplier feed arrives with every price as `0.00` and the import job dutifully publishes it. This happens more than anyone admits. Validate imports against the previous version (more than 5% of prices changing by more than 50% stops the import for a human to look), and keep a kill switch that freezes catalog updates.

**The deploy during peak.** Freeze deploys during big sales. The rest of the time, roll out region by region with a canary: send 5% of traffic to the new version in one region using the Gateway's traffic splitting, watch checkout success rate for 15 minutes, then continue. Make sure readiness probes reflect real readiness so a pod doesn't take traffic before its caches and connection pools are warm. [Readiness vs liveness](/blog/kubernetes-readiness-vs-liveness/) has the details.

**The bot that buys everything.** Scalper bots add every unit of a limited product to carts and hold them. Limit quantity per customer and per payment instrument, use reCAPTCHA on add-to-cart for limited items, keep holds short (10 to 15 minutes), and look at the Cloud Armor logs for the patterns afterwards.

## Data and personalisation

The last part of the store is the part that makes it smarter over time. It sits entirely off the checkout path, which is the most important thing about it.

<figure class="diagram wide"><a href="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-data-ai.svg" title="Open the full-size diagram"><img src="/assets/diagrams/gcp-ecommerce/gcp-ecommerce-data-ai.svg" alt="Data and personalisation flow. Sources on the left: an event collector on Cloud Run for views, searches and add-to-cart events, Spanner change streams for orders, prices and stock, and Cloud Storage for ERP and supplier files. In the middle, Move and shape: Pub/Sub for clickstream and order events, Dataflow streaming jobs that validate, deduplicate, join and drop personal data, and BigQuery with raw, curated and mart datasets. On the right, Use it: AI Commerce Search receives real-time user events from Pub/Sub and catalog and history from BigQuery and serves search and recommendations to the storefront on GKE, which calls it with a 150 ms timeout and falls back to bestsellers cached in Valkey. Gemini Enterprise Agent Platform uses BigQuery data for demand forecasting, return-risk models and a shopping agent, feeding merchandising and the ERP with reorder points, markdowns and which SKUs to pre-position. Dashboards on BigQuery show funnel, margin and stock-outs by hour to merchandisers, finance and operations. A panel lists rules: one versioned event schema, consent before user IDs, PII dropped in Dataflow, the same events sent to AI Commerce Search and analytics, catalog updates from Spanner change streams, and measuring recommendations by revenue per session in an A/B test." width="1500" height="780" loading="lazy"></a><figcaption>Events feed search, recommendations and forecasts. If this whole picture is down, the store still sells.</figcaption></figure>

The flow is straightforward. Clicks and searches go through a small collector on Cloud Run into Pub/Sub. Spanner change streams carry orders, price and stock changes. Dataflow validates and joins them and lands them in BigQuery. From there:

- **AI Commerce Search** gets your catalog and the same user events in near real time, and serves search results and recommendations. The storefront calls it with a short timeout (150 ms is a reasonable start) and falls back to a cached bestsellers list if it's slow, so a slow recommendation never slows down a product page.
- **Gemini Enterprise Agent Platform** trains and serves the models that are specific to your business, like demand forecasts per SKU per region, return-risk scores, or a shopping assistant agent. If you're building that platform side, the [AI platform engineer on Google Cloud](/blog/ai-platform-engineer-google-cloud/) article covers it.
- **Dashboards on BigQuery** give merchandising, finance and operations the funnel, margin and stock-out numbers by hour, which on a sale day is how they decide when to stop a promotion.

Two rules matter more than any tool choice. Get consent right: no user ID on events from shoppers who declined, and personal data dropped or hashed in Dataflow before it reaches BigQuery. And measure recommendations with an A/B test on revenue per session, not click-through rate, because a model that gets lots of clicks on cheap accessories can still lose money.

## What it costs, and where to save

Exact numbers depend on your traffic, so here's where the money goes and what to do about it instead of a price list:

- **Spanner** is usually the biggest single line. Use the managed autoscaler with a sensible minimum, pick the edition that matches the features you actually use, and keep analytics queries off it (that's what Data Boost and BigQuery are for).
- **The second region** roughly doubles compute. Running each region at 50% is the cost of a zero-touch failover. If you can accept a manual failover of 15 to 30 minutes, a smaller warm second region is a valid trade, as long as you write it down and test it.
- **Cloud CDN hit ratio** is the cheapest lever you have. Every point of cache hit ratio is backend capacity you don't pay for. Measure it per path.
- **GKE Autopilot** charges for pod requests, so right-size requests using real usage data. Run batch and feed generation on Spot pods.
- **Committed use discounts** for the baseline capacity you run all year, and on-demand for peaks.
- **Labels on everything** (`team`, `service`, `env`) and billing export to BigQuery, so you know what Black Friday actually cost.

## The problems you'll actually face

1. **The survivor region can't carry the load.** Each region ran at 80%, so failover overloads the survivor. Size for N+1 at the region level and test it.
2. **Cache treated as the source of truth.** Carts or stock that only live in Valkey disappear with a region. Keep the truth in Spanner, the copy in the cache.
3. **Hot rows.** One stock row for a popular SKU, or sequential order IDs, cap throughput regardless of database size.
4. **Non-idempotent checkout.** Double charges and duplicate orders from retries, double clicks and duplicated webhooks.
5. **Publishing events before commit.** Downstream ships orders that were rolled back. Use an outbox.
6. **Quotas found on the day.** The first thing to fail in most load tests is a quota, not code.
7. **Egress IPs not allow-listed.** The payment provider or ERP rejects the region you failed over to.
8. **CDN not doing its job.** Pages marked `private` or with cookies that vary the cache key, so the CDN passes every request to the backend. Check the cache hit ratio per path before the sale.
9. **Rate limits that hit real customers.** Many shoppers behind one mobile carrier IP. Key on a session cookie, and always use preview mode first.
10. **Slow third-party calls without timeouts.** One slow dependency ties up every connection in the checkout service.
11. **Price or catalog mistakes at scale.** No validation on imports, no kill switch.
12. **Alerts on CPU instead of outcomes.** The pager should go off when checkout success rate or p95 latency breaks the SLO, not when a pod is busy.

## Pre-flight checklist

- Global external Application Load Balancer with Cloud CDN, Cloud Armor and managed certificates
- Cloud Armor WAF rules, rate limits and bot rules, tested in preview before enforcing
- Two active regions, each sized to carry 100% of peak, with health checks and outlier detection
- Multi-cluster Gateway or equivalent, so both regions sit behind one global load balancer
- Spanner multi-region (or Cloud SQL with HA and a cross-region replica, with the RPO written down)
- Carts, orders and stock in the database; Memorystore only for copies
- Idempotency keys on checkout and on payment provider calls; deduplicated consumers
- Outbox (or change streams) for events; dead-letter topics on every subscription
- Stock holds with expiry and a release job; no reliance on TTL for timing
- Sharded counters or tokens ready for hot SKUs; UUIDv4 or bit-reversed IDs
- Card data handled only by the payment provider's hosted fields
- Static NAT IPs in both regions, allow-listed with every partner
- Quotas raised for peak, load test at 1.5x forecast, CDN warmed, deploy freeze agreed
- SLOs on checkout success rate and latency, alerts on burn rate
- Feature flags to shed non-essential features
- A region drain game day every quarter

## Download the diagrams

All five diagrams are editable draw.io files that use the Google Cloud shapes built into draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the regions, services and numbers to match your store.

- [All five diagrams in one file (5 pages)](/assets/diagrams/gcp-ecommerce/gcp-ecommerce-architecture.drawio)
- [Reference architecture](/assets/diagrams/gcp-ecommerce/gcp-ecommerce-reference.drawio)
- [Checkout, step by step](/assets/diagrams/gcp-ecommerce/gcp-ecommerce-checkout.drawio)
- [Scenario: a region goes down](/assets/diagrams/gcp-ecommerce/gcp-ecommerce-region-failure.drawio)
- [Scenario: flash sale and the hot SKU](/assets/diagrams/gcp-ecommerce/gcp-ecommerce-flash-sale.drawio)
- [Data and personalisation](/assets/diagrams/gcp-ecommerce/gcp-ecommerce-data-ai.drawio)

Traffic numbers, timings and region choices are examples. Product names are as of November 2026; check current quotas, SLAs and prices for your own regions before you build.

## References

- [Global external Application Load Balancer overview](https://cloud.google.com/load-balancing/docs/https)
- [Outlier detection for backend services](https://cloud.google.com/load-balancing/docs/https/traffic-management-global#outlier_detection)
- [Cloud CDN caching overview](https://cloud.google.com/cdn/docs/caching)
- [Cloud Armor rate limiting](https://cloud.google.com/armor/docs/rate-limiting-overview)
- [Cloud Armor bot management with reCAPTCHA](https://cloud.google.com/armor/docs/bot-management)
- [Multi-cluster Gateways on GKE](https://cloud.google.com/kubernetes-engine/docs/concepts/multi-cluster-gateways)
- [Spanner instance configurations](https://cloud.google.com/spanner/docs/instance-configurations)
- [Spanner schema design best practices](https://cloud.google.com/spanner/docs/schema-design)
- [Spanner change streams](https://cloud.google.com/spanner/docs/change-streams)
- [Memorystore for Valkey cross-region replication](https://cloud.google.com/memorystore/docs/valkey/create-manage-cross-region-replication)
- [Pub/Sub dead-letter topics](https://cloud.google.com/pubsub/docs/handling-failures)
- [AI Commerce Search documentation](https://cloud.google.com/retail/docs)
- [PCI DSS compliance on Google Cloud](https://cloud.google.com/security/compliance/pci-dss)
