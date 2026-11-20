---
title: "E-commerce on Azure: a reference architecture that survives a zone failure and a flash sale"
description: "Front Door Premium and WAF, AKS across three zones, Azure SQL for orders, Cosmos DB for catalog and carts, Azure Managed Redis, AI Search and Service Bus. How the pieces fit, and what happens when a zone dies, a drop sends 20x traffic, or a whole region goes. Editable draw.io diagrams included."
date: 2026-11-20T04:07:00Z
category: Cloud & DevOps
coverLabel: "Black Friday\non Azure,\nno outage."
coverCode: "Front Door · AKS · SQL · Cosmos DB"
coverLogos: "microsoft-azure, kubernetes"
coverImage: /assets/images/covers/azure-ecommerce-reference-architecture.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Black Friday on Azure, no outage.', with the Microsoft Azure and Kubernetes logos."
---
An online shop looks simple from the outside. Browse, search, add to cart, pay. Underneath, those four actions want completely different things from the platform. Browsing wants to be cached and cheap. Search wants a purpose-built engine. The cart wants fast writes and doesn't care much about joins. Checkout wants a real transaction, an idempotency key and a database that never loses a committed order.

Most outages I've seen in e-commerce come from ignoring that. One SQL database serving the catalog, the cart and the orders. One AKS node pool in one zone. A Redis cache that turned into the only copy of the stock count. It all works until the first big sale, and then everything fails at once.

This article is the Azure design I'd start from for a mid-to-large online store in late 2026. It has four editable `.drawio` diagrams built with draw.io's own Azure icons, which you can download at the end. The second half walks through the scenarios that actually happen in production: a zone going dark, a flash sale, a region outage, a slow payment provider, and prices that disagree with each other.

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-reference.svg" alt="Reference architecture. A global edge band holds shoppers, Azure DNS, Front Door Premium with a WAF policy (Default Rule Set 2.2, bot rules, rate limits), Entra External ID for customer sign-in and Blob Storage (GZRS) as the static origin for images, JS and CSS. Front Door reaches two regions over Private Link: Region A East US 2, primary for writes, and Region B Central US, secondary but serving reads all day. Each region has a spoke VNet with a Private Link service and an internal load balancer running a Gateway API ingress in front of an AKS cluster spread across zones 1, 2 and 3. The cluster runs storefront, catalog, search-api, cart, checkout, orders, payments, inventory, order-worker, notify, indexer and pricing. Data services sit behind private endpoints only: Azure SQL Business Critical zone-redundant for orders and payments, Cosmos DB NoSQL for catalog and carts, Azure Managed Redis for sessions and stock, AI Search with three replicas for the product index and Service Bus Premium for order events. A platform row holds Key Vault, workload identity, Container Registry Premium, Application Insights and Log Analytics. A bottom band lists cross-region replication: SQL failover group, Cosmos DB with per-partition automatic failover, Managed Redis active geo-replication, Service Bus geo-replication, AI Search not replicated but indexed per region from the Cosmos DB change feed, and Container Registry geo-replication." width="1640" height="1150" loading="lazy"></a><figcaption>The reference architecture: one Front Door, two regions, every data service private and zone-redundant.</figcaption></figure>

## The short version

- **Front Door Premium is the only way in.** It caches the pages that can be cached, runs the WAF at the edge, and reaches your clusters over Private Link so the origins have no public IP at all.
- **Pick the data store per job, not per company.** Azure SQL for orders, payments and stock (the money). Cosmos DB for the catalog and carts (lots of small documents, global reads). AI Search for search. Azure Managed Redis for cache, sessions and hot counters. Service Bus for everything that can happen after the customer clicks "Pay".
- **Make every tier zone-redundant first, multi-region second.** Zone failures are far more common than region failures, and zone redundancy is mostly a checkbox you tick on day one. Several of those checkboxes can't be ticked later.
- **Use Azure Managed Redis, not Azure Cache for Redis.** Basic, Standard and Premium Azure Cache for Redis retire on 30 September 2028, and new customers can no longer create them. Start new builds on Managed Redis.
- **Run reads active-active and writes active-passive.** Both regions serve browse, search and cart. Orders write to one primary region. Multi-region writes for money is a problem you don't want.
- **Put a queue between checkout and the order database.** A flash sale is a spike. A queue turns it into a slope your database can survive.

## The shop this is designed for

Numbers change designs, so here are the ones I'm assuming:

- Normal peak around 5,000 requests per second, sales peaks of 20x that for a few minutes.
- 2 million products, 50 million carts a year, a few hundred orders per second at the very top.
- Shoppers in North America first, Europe later. Two Azure regions to start: East US 2 and Central US.
- Recovery targets: a zone failure should be invisible apart from a few retries. A region failure should cost minutes of checkout, not hours, and lose zero orders that were confirmed to a customer.

If you're a tenth of this size, you can drop the second region and keep everything else. If you're ten times this size, you'll split the cluster per domain and look at deployment stamps, but the shape stays the same.

## The architecture, layer by layer

### Edge: Front Door Premium, WAF, DNS and sign-in

Front Door is a global layer 7 load balancer and CDN on Microsoft's edge network. Three things make it the right front door for a shop:

1. **Caching.** Product pages, category pages and the home page can be cached for 30 to 60 seconds with a rules engine rule that strips tracking query strings from the cache key. Images, fonts and JS come from Blob Storage and can be cached for a day. On a normal day 80 to 95% of GET requests never reach a region.
2. **WAF at the edge.** The WAF policy runs in the edge PoP, before traffic crosses into your region. Managed rule sets (the Default Rule Set and the Bot Manager rule set) need the Premium tier. Standard only gets custom rules.
3. **Private Link origins.** Premium can reach an internal load balancer through a Private Link service. Your AKS ingress gets a private IP, and the only route from the internet to your cluster is through Front Door and its WAF. You don't need IP allow lists or header checks to stop people bypassing the edge.

Customer sign-in goes to Microsoft Entra External ID, so you never store passwords and you get MFA, social logins and risk-based protection without writing it. Azure DNS hosts the zone and a CNAME points `shop.example.com` at the Front Door endpoint.

One Private Link detail to know before launch day: each Front Door regional cluster has a platform limit of 7,200 requests per second per profile for Private Link traffic, and returns 429 above it. If you expect more than that on cache misses, add more origins in the origin group with different Private Link regions so the traffic spreads over several Front Door regional clusters. Read the [Private Link FAQ](https://learn.microsoft.com/azure/frontdoor/private-link#frequently-asked-questions) before you size anything.

### Compute: one AKS cluster per region, across three zones

Each region runs one AKS cluster with node pools across zones 1, 2 and 3. You choose zones when you create the cluster and node pools, and you can't change it afterwards, so get this right first time.

Inside the cluster, services are split by domain: `storefront`, `catalog`, `search-api`, `cart`, `pricing`, `checkout`, `orders`, `payments`, `inventory`, plus the background workers `order-worker`, `notify` and `indexer`. That isn't a call to build twelve microservices on day one. A modular monolith with those boundaries inside it is fine. What matters is that browse traffic and checkout traffic can scale separately, and that a slow recommendation call can't block payments.

The rules that keep it resilient:

- **Spread pods across zones.** AKS sets a default zone spread with `maxSkew: 1` from Kubernetes 1.33, but write your own constraint for anything critical so it is explicit and reviewed.
- **A PodDisruptionBudget for every service**, so upgrades and node drains never take all replicas at once.
- **Size each zone for half of peak, not a third.** When one zone goes, the other two have to carry the whole load while new nodes start.
- **Workload identity everywhere.** Pods authenticate to SQL, Cosmos DB, Redis, Service Bus and Key Vault with Microsoft Entra tokens. There are no connection strings with keys in them.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
spec:
  replicas: 6
  template:
    metadata:
      labels:
        app: checkout
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: checkout
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels: { app: checkout }
      containers:
        - name: checkout
          image: shopacr.azurecr.io/checkout:1.42.0
          resources:
            requests: { cpu: "500m", memory: 512Mi }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout
spec:
  minAvailable: 4
  selector:
    matchLabels: { app: checkout }
```

### Data: one store per job

This is the part that decides whether the shop survives its first big sale.

| Data | Store | Why |
|---|---|---|
| Orders, payments, stock of record | Azure SQL Database, Business Critical, zone-redundant | Real transactions, constraints, and an outbox table in the same transaction as the order. Zone-redundant failover has an RPO of zero. |
| Product catalog | Cosmos DB for NoSQL | Product documents vary by category, reads are global, and the change feed drives search indexing. |
| Carts | Cosmos DB for NoSQL, partition key `/cartId`, TTL | One small document per cart, written often, read by key. No joins. Expired carts delete themselves. |
| Sessions, cache, hot stock counters, admission tokens | Azure Managed Redis | Sub-millisecond reads, atomic counters, zone-redundant by default, Entra ID auth by default. |
| Search, facets, typeahead | Azure AI Search | Relevance, facets, synonyms and vector search. Never the source of truth. |
| Order events | Service Bus Premium, topic `order-events` | Ordered, durable, dead-lettered, and zone-redundant. Decouples checkout from everything after it. |

Two notes on naming, because the docs moved this year. Microsoft Learn now lists Azure AI Search as "Foundry IQ (Azure AI Search)" in places. It's the same service. And Azure Cache for Redis is on its way out: Basic, Standard and Premium retire on 30 September 2028, Enterprise and Enterprise Flash on 31 March 2027, and new customers have been blocked from creating Basic, Standard or Premium caches since 1 April 2026. Azure Managed Redis is the replacement, and it's what this design uses.

Every one of these services sits behind a private endpoint with public network access turned off. The only things with public endpoints are Front Door and Entra External ID.

### Platform

Key Vault per region for the TLS certificate Front Door presents and anything that truly has to be a secret. Container Registry Premium with geo-replication so each region pulls images locally. Application Insights for traces across services, and Log Analytics for logs and alerts. Each region is a self-contained copy, so a region outage doesn't take your observability with it.

If you're building the landing zone with Terraform, the subscription and state layout from [Terraform on Azure: how an enterprise should start](/blog/terraform-azure-enterprise-guide/) applies directly: one subscription per environment, a spoke VNet per region, and the shop's modules pinned to versions.

## Five requests, five paths

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-flows.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-flows.svg" alt="Request flows in five rows. Row 1 Browse: Front Door with a 60 second cache, then on a cache miss storefront renders the page, catalog API reads Managed Redis cache-aside, and Cosmos DB only on a cache miss. Row 2 Search: Front Door with no cache, search-api query builder, AI Search for query and facets; separately the indexer reads the Cosmos DB change feed and upserts documents into AI Search. Row 3 Cart: Front Door, cart service writes to Cosmos DB with partition key cartId and a 30 day TTL using an ETag, pricing service reads a price and promo cache in Managed Redis. Row 4 Checkout in green: Front Door rate limited, checkout orchestrates, inventory reserves stock, payments authorizes only, the payment provider is called with an idempotency key, orders writes the order and an outbox row in one Azure SQL transaction. Row 5 After the order: an outbox relay polls the SQL outbox table and publishes OrderPlaced to the Service Bus Premium topic order-events, with four subscriptions for payments (capture), inventory (reserved to sold), notify (confirmation email) and fulfilment (send to warehouse or 3PL). Rules for every subscriber: peek-lock, idempotent handlers, max delivery count 10 then dead-letter, KEDA scaling per subscription, duplicate detection with MessageId equal to orderId." width="1640" height="1000" loading="lazy"></a><figcaption>What each shopper action touches. Only checkout writes to Azure SQL, and only checkout has to be strongly consistent.</figcaption></figure>

The pattern to notice is that **only one row writes to SQL synchronously**. Browse is cached. Search reads an index that's allowed to be a few seconds behind. The cart is a Cosmos DB document. Everything after the order happens through Service Bus.

Checkout itself is short and strict:

1. **Reserve stock** in `inventory`. The reservation has an expiry, so an abandoned checkout gives the stock back.
2. **Authorize the payment**, never capture it yet. Send the provider an idempotency key derived from the checkout ID, so a retry is the same request rather than a second charge.
3. **Write the order and an outbox row in one SQL transaction.** The order exists if and only if the event to announce it exists.

Then an outbox relay publishes `OrderPlaced` to the topic, and each subscriber does its own job: capture the payment, mark stock as sold, send the email, tell the warehouse. If the email service is down, orders still go through. The messages wait.

## Scenario 1: a zone goes dark on a Friday evening

At 20:14 on a Friday, zone 2 of East US 2 loses power. This happens more often than people think, and it's the scenario your design should make boring.

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-zone-failure.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-zone-failure.svg" alt="Zone failure scenario. Region A East US 2 with three zone columns; zone 2 is shaded red with power lost. For each service row: AKS loses 4 nodes in zone 2 with pods evicted after about 5 minutes, while zones 1 and 3 grow from 4 to 6 nodes. Azure SQL loses its primary replica in zone 2 and a secondary in zone 1 becomes the new primary in under 30 seconds with zero data loss. Cosmos DB loses a replica and writes keep going. Managed Redis loses primary shards and replicas are promoted in seconds. AI Search loses its primary replica, another is promoted and unreplicated writes may be lost. Service Bus Premium loses capacity and senders retry with no data loss. The zone 2 NAT gateway goes down with its zone. A timeline on the right: 0 s in-flight requests fail with 502 and 504; 5 to 15 s probes stop sending to zone 2 and Redis and Search promote replicas; under 30 s Azure SQL completes its zone failover; about 1 minute HPA adds replicas and some go Pending; 2 to 5 minutes new nodes arrive in zones 1 and 3 if capacity exists; 5 minutes pods on unreachable nodes are evicted; when the zone returns nothing rebalances by itself. A checklist lists what must be built in advance." width="1640" height="1020" loading="lazy"></a><figcaption>A zone failure, service by service. Most of it is automatic, if you configured it before it happened.</figcaption></figure>

What the platform does for you:

- **Azure SQL** Business Critical with zone redundancy keeps replicas in other zones. Microsoft's own numbers for zone-redundant high availability are an RTO typically under 30 seconds and an RPO of zero. Open connections drop. Your app reconnects if it has retry logic.
- **Cosmos DB** zone-redundant accounts keep writing. No failover, no action.
- **Managed Redis** promotes replica shards in seconds. Clients see a short connection blip and need to refresh their cluster topology.
- **AI Search** with at least two replicas keeps answering queries. If the primary replica was in zone 2, another one is promoted within seconds, and writes that hadn't replicated yet can be lost. Your indexer has to be able to replay from the change feed.
- **Service Bus Premium** handles it inside the service. Senders retry.

What you have to have built:

- **Spare capacity in the surviving zones.** HPA will want more pods, and the autoscaler will want more nodes, in exactly the zones and VM sizes everyone else in the region also wants right now. Running each zone at 50% of peak means you survive even if no new nodes arrive.
- **Short client timeouts and retries with backoff** for SQL, Redis and Search. The default timeouts in many SDKs are long enough to exhaust your thread pool before failover finishes.
- **Nothing zonal that you forgot.** The classics: a StatefulSet on an LRS managed disk (it can't move to another zone, use ZRS disks), a NAT gateway in one zone (NAT gateways are zonal, use one per zone with matching node pools, or route egress through a zone-redundant firewall), and a self-hosted service with one replica.
- **Patience about rebalancing.** Pods on unreachable nodes only get evicted after the default `tolerationSeconds` of 300. When the zone comes back, Kubernetes doesn't move anything back on its own. Roll the deployments or run the descheduler, or the next zone failure will hit an unbalanced cluster.

Test all of this. Azure Chaos Studio can simulate a zone going down for AKS and other services, and a quarterly drill in a production-like environment finds the one thing nobody remembered.

## Scenario 2: a limited drop sends 20x traffic in 90 seconds

Marketing announces a limited sneaker drop at 18:00. At 17:59 there are 300,000 people on the page. At 18:00 they all press the button.

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-flash-sale.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-flash-sale.svg" alt="Flash sale scenario as seven stages. 1 Front Door cache: drop pages cached 30 to 60 seconds, about 100 thousand requests per second in. 2 WAF at the edge: Bot Manager rule set, JavaScript challenge on the drop path, rate limit of 100 requests per minute per IP on cart and checkout. 3 Admission tokens: storefront issues checkout tokens from Managed Redis at a fixed rate, everyone else sees a queue page, about 2 thousand checkouts per second let in. 4 AKS pre-scaled: minimum replicas raised an hour before, HPA on requests per second, KEDA on queue depth, spare nodes held by low-priority pods. 5 Stock in Redis: one counter per SKU decremented atomically, so overselling is impossible. 6 Service Bus queue: checkout returns 202 and workers drain the queue at the pace SQL can take. 7 Azure SQL writes orders in batches at about 400 orders per second and stays the source of truth. Below, what breaks first: a hot stock row in SQL, a hot Cosmos DB partition, AI Search scaled too late, pending pods with no nodes, and a WAF rate limit blocking a whole mobile carrier NAT. And a runbook from T minus 24 hours to T plus 1 hour." width="1640" height="900" loading="lazy"></a><figcaption>Every layer says no early and cheaply, so the order database only sees what it can take.</figcaption></figure>

The design principle is simple: **the order database is the one thing that can't scale in 90 seconds, so nothing is allowed to send it more than it can take.** Every layer in front of it has a job.

**Front Door absorbs the reads.** The drop page, product images and scripts are all cached. If 300,000 people refresh every five seconds, that's 60,000 requests per second that Front Door answers from the edge.

**The WAF removes the bots.** Limited drops attract scalpers with scripts. Turn on the Bot Manager rule set and the JavaScript challenge for the drop path, and add per-IP rate limits on `/cart` and `/checkout`. Be careful with the threshold. A rate limit counted per client IP can throttle every customer behind one mobile carrier's NAT, so run new rules in detection mode during a smaller sale first. On Premium you can also group rate limits by other keys, some of which are still in preview.

**Admission control lets in what the backend can handle.** Azure doesn't sell a waiting room, so build a small one. The storefront asks Redis for an admission token before it shows the checkout button. Tokens are issued at a fixed rate that you choose from load tests. Everyone else sees an honest "you're in the queue" page that polls.

**Stock lives in Redis during the sale.** One counter per SKU, decremented atomically. Thousands of concurrent buyers can't oversell 500 units, because Redis executes each command one at a time:

```lua
-- KEYS[1] = stock:{sku}   ARGV[1] = quantity
local left = redis.call('DECRBY', KEYS[1], ARGV[1])
if left < 0 then
  redis.call('INCRBY', KEYS[1], ARGV[1])  -- give it back, sold out
  return -1
end
return left
```

SQL is still the source of truth. A job reconciles the Redis counters against reservations and orders every minute, and after the sale.

**The queue turns a spike into a slope.** Checkout validates the cart, takes the token, reserves the stock, authorizes the payment and puts a `PlaceOrder` message on Service Bus. It returns `202 Accepted` with an order number straight away. Workers drain the queue at the rate SQL can absorb, and KEDA scales them on queue depth:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-worker
spec:
  scaleTargetRef:
    name: order-worker
  minReplicaCount: 4
  maxReplicaCount: 60
  triggers:
    - type: azure-servicebus
      metadata:
        namespace: shop-prod-eus2
        queueName: place-order
        messageCount: "50"
      authenticationRef:
        name: servicebus-workload-identity
```

Set `maxReplicaCount` from what SQL can take, not from what AKS can run. Sixty workers each writing 10 orders per second is the 600 orders per second your database was tested for. A hundred and twenty is an incident.

What breaks first when nobody planned for the sale:

- **One hot row.** `UPDATE stock SET qty = qty - 1 WHERE sku = @sku` from thousands of sessions turns into lock waits, timeouts and retries that make it worse. That's why the counter lives in Redis for the sale.
- **One hot partition.** Cosmos DB scales by partition. A container keyed by `/skuId` puts the whole drop on one physical partition, which returns 429s however many RU/s you buy. Key carts by `/cartId`.
- **Search scaled too late.** Adding AI Search replicas runs in the background and can take hours. Scale it the day before.
- **Pending pods, no nodes.** HPA wants 300 pods, the node pool maximum is 40, and the region is short of that VM size today. Raise node pool limits, request quota early, and keep low-priority buffer pods that get evicted to make room instantly.

## Scenario 3: the whole primary region is down

It's rarer, but it happens: networking problems, a bad platform deployment, a storage outage. East US 2 is unusable, and you need to decide what moves.

Here's what happens with this design, in order:

1. **Front Door moves the traffic on its own.** Its health probes see the East US 2 origins failing and send everything to Central US. Browse, search and cart keep working, because they were already running there all day. That's the payoff of keeping reads active-active: the secondary region is warm, has its cache full and has been taking real traffic.
2. **Cosmos DB recovers writes by itself, if you enabled per-partition automatic failover.** With PPAF, affected partitions promote a new write region on their own, typically in under three minutes at P99. Without it, you have to take the region offline yourself, and service-managed failover can take an hour or more. Turn on PPAF for single-write-region accounts on the NoSQL API.
3. **Someone decides to fail over SQL.** Use a failover group with a customer-managed failover policy. Microsoft-managed failover only triggers after Microsoft declares an outage, which can take a long time. When your on-call runs the failover, the read-write listener moves to Central US and apps reconnect without config changes. Because geo-replication is asynchronous, a forced failover can lose the last few seconds of transactions.
4. **Promote Service Bus.** With Service Bus geo-replication on the Premium namespace, promote Central US to primary. A planned promotion replicates in-flight messages first. In a real outage you'll do a forced promotion, which starts immediately and can lose unreplicated messages.
5. **Redis is already writable in both regions** with active geo-replication. Treat it as cache. Sessions survive, but nothing in Redis should be the only copy of anything.
6. **AI Search isn't replicated by Azure.** Each region has its own index, fed by its own indexer from the Cosmos DB change feed, so Central US already has an index that's seconds behind.

The data loss question is the one to settle in advance, with the business, not during the incident. Asynchronous replication means a forced failover can lose the last few seconds of orders that were committed in East US 2. The outbox helps here: every order has a matching event, so you can find the gap afterwards by comparing what reached the payment provider with what exists in SQL, and contact those customers. Write that reconciliation query now. And practise the whole failover twice a year, with a stopwatch.

## Scenario 4: the payment provider gets slow

Your payment provider's P99 goes from 400 ms to 12 seconds. Nothing in Azure is broken, and checkout is falling over anyway, because every checkout pod has threads waiting on payment calls.

The fixes are all in the code, and they need to be there before it happens:

- **A tight timeout on the authorize call**, 3 to 5 seconds, not the HTTP client default of 100 seconds.
- **A circuit breaker** that opens when the error or timeout rate passes a threshold, and shows customers "payments are slow, please try again in a minute" instead of a spinner.
- **The same idempotency key on every retry**, so a timed-out request that actually succeeded at the provider isn't charged twice.
- **Authorize synchronously, capture asynchronously.** Capture happens from the `payments` subscription on Service Bus, so a slow capture never blocks a customer.
- **A bulkhead.** Payments gets its own deployment and connection pool, so a slow provider can't starve browse or cart of threads.

## Scenario 5: the price in search doesn't match the price in the cart

A customer finds a TV for 399 in search, opens the product page and sees 449. They post a screenshot. It's not a bug in any single service. It's three caches with three different ages: the search index, the product page cached at Front Door, and the price cache in Redis.

You can't make them all consistent at once, so decide which one is allowed to be wrong and which one never is:

- **Search and product pages may be a few seconds old.** Say so in the design, and keep the lag small: push price changes through the Cosmos DB change feed to the indexer, and purge the Front Door cache for that product when the price changes.
- **The cart and checkout must always reprice from the source.** The `pricing` service reads the live price at add-to-cart and again at checkout. If it changed, the customer sees the new price before they pay. In many places consumer law expects it too.

## Where the money goes

The services that dominate the bill in this design, roughly in order:

- **Azure SQL Business Critical** in two regions. Business Critical is expensive because it runs local replicas on SSD. If your order volume is modest, General Purpose with zone redundancy is a reasonable step down, with slower failover.
- **AKS nodes** sized for 50% per zone headroom, in both regions. Spot node pools for the indexer and other interruptible workers save a lot.
- **Cosmos DB** RU/s in two regions. Use autoscale, and set the maximum per container rather than per database.
- **Front Door Premium.** It has a fixed monthly base fee plus requests and data transfer, and it pays for itself by keeping traffic away from your origins.

## Pre-launch checklist

- [ ] Front Door Premium, WAF in prevention mode after weeks in detection mode, Private Link origins approved in both regions
- [ ] AKS node pools in three zones, PDBs on every service, zone spread constraints on critical services
- [ ] Every data service zone-redundant and behind a private endpoint, public network access off
- [ ] Azure Managed Redis, not Azure Cache for Redis, with Entra ID auth and no access keys
- [ ] AI Search with at least three replicas (two for read-only SLA, three for read-write)
- [ ] SQL failover group with a customer-managed failover policy, runbook tested
- [ ] Cosmos DB per-partition automatic failover on, SDKs at supported versions
- [ ] Service Bus Premium geo-replication on, promotion rehearsed
- [ ] Outbox pattern for orders, idempotent subscribers, dead-letter alerts
- [ ] Load test at 20x normal peak, with the admission rate and worker maximums set from the results
- [ ] Zone-down and region-down drills done in the last quarter

## Download the diagrams

All four diagrams are editable draw.io files using draw.io's built-in Azure icon library. Open them at [app.diagrams.net](https://app.diagrams.net) or in the draw.io desktop app.

- [All four diagrams in one file (4 pages)](/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-reference-architecture.drawio)
- [Reference architecture](/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-reference.drawio)
- [Request flows](/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-flows.drawio)
- [Zone failure scenario](/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-zone-failure.drawio)
- [Flash sale scenario](/assets/diagrams/azure-ecommerce-reference/azure-ecommerce-flash-sale.drawio)

## References

- [Use Azure Front Door to secure AKS workloads](https://learn.microsoft.com/azure/architecture/example-scenario/aks-front-door/aks-front-door)
- [Secure your origin with Private Link in Azure Front Door Premium](https://learn.microsoft.com/azure/frontdoor/private-link)
- [Architecture best practices for Azure Front Door](https://learn.microsoft.com/azure/well-architected/service-guides/azure-front-door)
- [Rate limiting for Azure Front Door WAF](https://learn.microsoft.com/azure/web-application-firewall/afds/waf-front-door-rate-limit)
- [Zone resiliency recommendations for AKS](https://learn.microsoft.com/azure/aks/reliability-zone-resiliency-recommendations)
- [Availability through redundancy, Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/high-availability-sla-local-zone-redundancy)
- [Business continuity in Azure SQL Database: RTO and RPO](https://learn.microsoft.com/azure/azure-sql/database/business-continuity-high-availability-disaster-recover-hadr-overview)
- [Failover groups for Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/failover-group-sql-db)
- [Per-partition automatic failover in Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/per-partition-automatic-failover)
- [Reliability in Azure Managed Redis](https://learn.microsoft.com/azure/reliability/reliability-managed-redis)
- [Azure Cache for Redis retirement FAQ](https://learn.microsoft.com/azure/azure-cache-for-redis/retirement-faq)
- [Reliability in Foundry IQ (Azure AI Search)](https://learn.microsoft.com/azure/reliability/reliability-foundry-iq)
- [Service Bus geo-replication](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-geo-replication)
