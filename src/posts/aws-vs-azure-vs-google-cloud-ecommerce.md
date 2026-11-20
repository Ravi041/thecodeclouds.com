---
title: "AWS vs Azure vs Google Cloud for e-commerce: which one to pick, and when"
description: "A service-by-service map of AWS, Azure and Google Cloud for an online shop (compute, databases, cache, search, messaging, CDN and WAF), what each one really costs to run, and four real scenarios from a five-person startup to a 400-store retailer. With editable draw.io diagrams."
date: 2026-11-20T04:10:00Z
category: Cloud & DevOps
coverLabel: "Same shop.\nThree clouds.\nOne choice."
coverCode: "aws | azure | gcloud  →  checkout"
coverLogos: "aws, microsoft-azure, google-cloud"
coverImage: /assets/images/covers/aws-vs-azure-vs-google-cloud-ecommerce.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Same shop. Three clouds. One choice.', with the AWS, Microsoft Azure and Google Cloud logos."
---
Every e-commerce team asks this at some point, usually in a meeting where someone has just come back from a cloud provider's summit with a bag of credits: which cloud should the shop run on?

The honest answer is that all three can run a store doing a billion in sales. Zalando, Shopify, Wayfair, Marks & Spencer and plenty of others are proof that the platform is not what decides whether Black Friday goes well. What decides it is whether your team knows the platform, whether the database was designed for the spike, and whether checkout degrades gracefully when something behind it is slow.

So this article doesn't crown a winner. It maps the building blocks of an online shop to the managed service each cloud gives you, points out the places where they really do differ, shows what drives the bill, and then walks through four real situations and what I would pick in each one. All three diagrams are editable `.drawio` files built with the official AWS, Azure and Google Cloud shapes that ship with draw.io, and you can download them at the end.

This is the last part of the e-commerce series. The earlier parts covered design foundations, service boundaries, checkout consistency, caching and flash sales, and the reference builds on each cloud. Here we put the three side by side.

## The service map

An online shop, stripped down, needs the same thirteen things no matter where it runs. Here they are, with the default pick on each cloud and the usual alternative.

<figure class="diagram wide"><a href="/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-service-map.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-service-map.svg" alt="A table of thirteen e-commerce layers with the AWS, Microsoft Azure and Google Cloud service for each. Edge CDN and WAF: CloudFront with AWS WAF and Shield Advanced; Azure Front Door Premium with a WAF policy; Cloud CDN with Cloud Armor on the global external Application Load Balancer. Load balancing and APIs: Application Load Balancer and API Gateway; Application Gateway for Containers and API Management; Cloud Load Balancing with the Gateway API and Apigee. Containers: Amazon EKS Auto Mode or ECS on Fargate; AKS Automatic or Container Apps; GKE Autopilot or Cloud Run. Functions: Lambda and Step Functions; Azure Functions Flex Consumption and Durable Functions; Cloud Run functions and Workflows. Relational database: Aurora PostgreSQL or MySQL and Aurora DSQL; Azure SQL Database Hyperscale or Azure Database for PostgreSQL; Cloud SQL or AlloyDB and Spanner. NoSQL: DynamoDB; Cosmos DB; Firestore or Bigtable. Cache: ElastiCache for Valkey; Azure Managed Redis; Memorystore for Valkey. Product search: Amazon OpenSearch Service; Azure AI Search; Google Search for commerce or Elastic Cloud from Marketplace. Messaging: SQS, SNS and EventBridge; Service Bus and Event Grid; Pub/Sub, Eventarc and Cloud Tasks. Streaming and analytics: Kinesis or MSK with Redshift or Athena; Event Hubs with Fabric or Synapse; Pub/Sub into BigQuery or Managed Service for Apache Kafka. Object storage: S3; Blob Storage; Cloud Storage. Customer identity: Cognito; Microsoft Entra External ID; Identity Platform. Observability: CloudWatch and X-Ray; Azure Monitor and Application Insights; Cloud Monitoring, Logging and Trace." width="1500" height="1068" loading="lazy"></a><figcaption>Thirteen building blocks, three clouds. Most rows are close equivalents; the interesting differences are in search, NoSQL pricing, messaging semantics and the edge.</figcaption></figure>

Most of that table is a straight swap. Object storage is object storage. Managed Kubernetes is managed Kubernetes. A Valkey cache on one cloud behaves like a Valkey cache on another. If you only read one thing from this section, read this: **about 80% of your architecture will look the same on all three clouds.** The rest is where the decision actually lives, so let's go through it.

### Edge: CDN and WAF

All three put a CDN and a web application firewall in front of the shop, and all three can absorb a large DDoS without you noticing. The differences are in how they bill and how much you get in the box.

- **AWS** splits it into pieces: CloudFront for the CDN, AWS WAF billed per web ACL, per rule and per million requests, and Shield Advanced (a monthly subscription with a one-year commitment) if you want the DDoS response team and cost protection for scaling during an attack. Bot Control is an extra managed rule group. You pay for exactly what you switch on, which is good until someone switches everything on.
- **Azure Front Door Premium** bundles CDN, global load balancing, WAF with managed rule sets, bot protection and Private Link to your origins. It has a fixed monthly base fee before any traffic, which is noise for a large retailer and a real line item for a small one. The Standard tier is much cheaper but has no managed WAF rules or Private Link.
- **Google Cloud** puts Cloud CDN and Cloud Armor on the global external Application Load Balancer. One anycast IP serves every region, which makes multi-region failover simple. Cloud Armor is pay-as-you-go per policy and rule, or Cloud Armor Enterprise as a subscription with adaptive protection and DDoS response.

For a shop, the feature that matters most here is bot management. Scalpers on a sneaker drop and credential-stuffing bots on the login page are real traffic you pay to serve. All three have it now; check that it is in the tier you're pricing.

### Compute: Kubernetes, or not

The three managed Kubernetes services have converged a lot. EKS Auto Mode, AKS Automatic and GKE Autopilot all manage the nodes for you, patch them, and scale them based on what your pods ask for.

GKE Autopilot is still the most hands-off of the three, and it bills by the CPU and memory your pods request rather than by node. For a shop with a quiet night and a busy evening, that is a good fit, as long as your resource requests are honest. Pods that request 2 CPU and use 0.2 cost you 2 CPU.

EKS is the one where you make the most decisions yourself: which add-ons, which ingress controller, Karpenter or Auto Mode, how IAM maps to pods. That's more work on day one and more control on day 400. AKS sits in the middle and is the natural choice if your engineers already live in Azure DevOps or GitHub with Entra ID.

All three charge a cluster management fee of about ten cents an hour for a cluster with an uptime SLA (AKS has a free tier without the SLA, GKE gives a monthly credit that covers one cluster per billing account). That is around $73 a month per cluster, so it only matters if you are tempted to run one cluster per team.

If your team is small, ask whether you need Kubernetes at all. **Cloud Run** on Google Cloud, **Container Apps** on Azure and **ECS on Fargate** on AWS all run containers without a cluster. Cloud Run and Container Apps scale to zero, which a shop with real overnight quiet will notice on the bill.

### Relational database: where orders live

Orders, payments and inventory belong in a relational database with transactions. All three clouds offer managed PostgreSQL and MySQL. The flagship options differ:

- **Aurora** (PostgreSQL or MySQL compatible) separates storage from compute, keeps six copies across three Availability Zones, and fails over in well under a minute. Pick I/O-Optimized if your workload is write-heavy, because standard Aurora charges per I/O and checkout is I/O. **Aurora DSQL** adds active-active writes across Regions if you really need it.
- **Azure SQL Database Hyperscale** is the obvious choice if your team writes T-SQL and has SQL Server licences to bring. **Azure Database for PostgreSQL Flexible Server** is the PostgreSQL path.
- **Cloud SQL** covers the normal case. **AlloyDB** is Google's PostgreSQL-compatible answer to Aurora, faster for mixed analytical queries. **Spanner** is the one service on this list with no real equivalent: a relational database with strong consistency across regions. If you sell the same stock in Europe and the US and refuse to oversell by even one unit, Spanner is the cleanest answer on any cloud.

Most shops don't need Spanner or DSQL. One region with a hot standby in a second zone, plus a cross-region replica for disaster recovery, is enough for the vast majority.

### NoSQL: carts, sessions and the catalog

This is where the pricing models diverge the most, and where surprises happen.

- **DynamoDB** bills per read and write request (on-demand) or per provisioned capacity. It is predictable once you understand partition keys. A cart keyed by `customerId` is fine. A "global stock counter" item that every checkout updates is a hot partition waiting to throttle on Black Friday.
- **Cosmos DB** bills in Request Units. A point read of a 1 KB document is 1 RU; a cross-partition query can be hundreds. Teams that move from SQL Server and write SQL-style queries against Cosmos DB are the ones who get the surprising invoice. Choose the partition key before you write any code, and use autoscale or serverless for spiky traffic.
- **Firestore** bills per document read, write and delete. It is lovely for a small team (no capacity to manage), but a product listing page that reads 60 documents per view costs 60 reads per view. Keep a sustained write rate of about one write per second per document in mind for anything like a counter.

### Cache

All three have moved towards Valkey, the open-source fork of Redis. **ElastiCache for Valkey** and **Memorystore for Valkey** are both priced below their Redis OSS equivalents. On Azure, Azure Cache for Redis retires on 30 September 2028 and new caches are already blocked, so **Azure Managed Redis** is the service to build on. Functionally they are interchangeable for sessions, price caches and rate limiting.

### Product search: the one real gap

Search is where the clouds are least alike.

- **AWS** has **Amazon OpenSearch Service**, a managed OpenSearch (the Elasticsearch fork), with a serverless option. It is the familiar Lucene world: analyzers, synonyms, facets, and the operational care that comes with shards.
- **Azure AI Search** is a fully managed search service with keyword, vector and hybrid queries built in, and semantic ranking on top. It's easier to run than OpenSearch and less flexible to tune.
- **Google Cloud** has no first-party managed OpenSearch or Elasticsearch. Your options are Elastic Cloud from the Marketplace (billed through Google), running OpenSearch yourself on GKE, or Google's own managed commerce search (the product formerly known as Retail Search and Vertex AI Search for commerce; Google has been renaming its AI products through 2026, so check the current name). That last one gives you personalised ranking trained on your shoppers' events, which is very good if you feed it clean event data and a black box if you don't.

If your merchandising team wants to hand-tune synonyms and boosts every week, OpenSearch or Elastic is the comfortable path on any cloud.

### Messaging: order events

An order placed in checkout should become an event that payments, the warehouse, email and analytics each consume at their own pace. All three can do this; their semantics differ.

- **SQS and SNS** are simple and very hard to break. FIFO queues with a message group per order give you ordering where you need it. **EventBridge** routes events by content to many targets.
- **Azure Service Bus** is the most "enterprise broker" of the three: sessions for per-order ordering, duplicate detection, dead-lettering, scheduled messages and transactions. If you are integrating with an ERP and warehouse systems, Service Bus feels like home.
- **Pub/Sub** is global by default, with ordering keys and exactly-once delivery for pull subscriptions in a region. Its killer feature for a shop is that a BigQuery subscription writes events straight into a table with no pipeline code at all.

Whatever you choose, make consumers idempotent. Every one of these services will, at some point, deliver a message twice.

## One storefront, three clouds

Here is the same shop built three times. Same services, same flows, different logos.

<figure class="diagram wide"><a href="/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-storefront.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-storefront.svg" alt="The same e-commerce architecture drawn three times, one lane per cloud. In each lane shoppers on web and app go through the edge (CloudFront with AWS WAF, Front Door with WAF, or Cloud CDN with Cloud Armor), then a load balancer (Application Load Balancer, Application Gateway for Containers, or the external Application Load Balancer), into a managed Kubernetes cluster (Amazon EKS Auto Mode, AKS Automatic, or GKE Autopilot) running storefront, cart and checkout services. Blue read paths go from storefront to the cache (ElastiCache, Azure Managed Redis, Memorystore) and product search (OpenSearch Service, Azure AI Search, Search for commerce), and from cart to the NoSQL cart store (DynamoDB, Cosmos DB, Firestore). Orange write paths go from checkout to the relational database (Aurora PostgreSQL, Azure SQL Database, Cloud SQL or AlloyDB) and to the message queue (SQS and SNS, Service Bus, Pub/Sub). A dashed purple path goes from the queue to functions (Lambda, Azure Functions, Cloud Run functions) that send emails and invoices." width="1500" height="1080" loading="lazy"></a><figcaption>The same five steps on each cloud. If you can draw your shop like this, you can move it, and you can price it on all three.</figcaption></figure>

Walk through it once and the differences shrink:

1. **Shopper traffic** hits the edge. Static assets and cacheable product pages are served from the CDN; the WAF drops bots and obvious attacks before they cost you compute.
2. **Services run as pods** in a managed cluster and scale on request rate. Storefront, cart and checkout are separate deployments so a slow search can't starve checkout of CPU.
3. **Reads** come from the cache first, then search and the cart store. Most page views never touch the relational database.
4. **Checkout writes** the order to the relational database in one transaction, then publishes an `OrderPlaced` event. Use an outbox table so the write and the event can't disagree.
5. **Functions** pick up the event to send the confirmation email, generate the invoice and update stock in the warehouse system, outside the shopper's request.

The code that matters (the cart, checkout, the outbox, the consumers) is the same on all three. That's the point: the cloud choice changes your SDK calls and your Terraform, not your design.

### The flash-sale check, three ways

Here is a concrete example of the same idea expressed on each cloud's preferred store: decrement stock only if there is stock left, atomically, so two shoppers can't buy the last pair.

On **AWS** with DynamoDB, a conditional update does it in one call:

```bash
aws dynamodb update-item \
  --table-name inventory \
  --key '{"sku": {"S": "SNEAKER-RED-42"}}' \
  --update-expression "SET stock = stock - :q" \
  --condition-expression "stock >= :q" \
  --expression-attribute-values '{":q": {"N": "1"}}'
# ConditionalCheckFailedException = sold out, show the shopper a clean message
```

On **Azure** with Cosmos DB, a partial update with a filter predicate:

```csharp
var ops = new[] { PatchOperation.Increment("/stock", -1) };
var opts = new PatchItemRequestOptions { FilterPredicate = "FROM c WHERE c.stock >= 1" };
// Throws CosmosException with status 412 (precondition failed) when sold out
await container.PatchItemAsync<Inventory>("SNEAKER-RED-42", new PartitionKey("SNEAKER-RED-42"), ops, opts);
```

On **Google Cloud** with Cloud SQL, AlloyDB or Spanner, plain SQL:

```sql
UPDATE inventory
SET stock = stock - 1
WHERE sku = 'SNEAKER-RED-42' AND stock >= 1;
-- 0 rows updated = sold out
```

Same rule, three dialects. For a genuinely hot SKU with tens of thousands of buyers in the first minute, none of these alone is enough; you shard the stock into buckets or put a queue in front of reservation, on any cloud.

## What drives the bill

People compare clouds on the list price of a VM. For an online shop that is rarely what decides the invoice. These are the things that do.

| Cost driver | AWS | Azure | Google Cloud |
|---|---|---|---|
| Steady compute discount | Savings Plans and Reserved Instances, 1 or 3 years | Reservations and Azure savings plan, 1 or 3 years | Committed use discounts, 1 or 3 years, plus automatic sustained use discounts on some machine types |
| Licences you already own | Bring your own licence, limited | Azure Hybrid Benefit for Windows Server and SQL Server, often the single biggest saving | Bring your own licence, limited |
| Spiky traffic | Spot instances, Fargate, Lambda | Spot VMs, Container Apps, Functions | Spot VMs, Autopilot per-pod billing, Cloud Run scale to zero |
| Traffic between zones | Charged per GB in each direction | Not charged (Microsoft's documentation says so explicitly) | Charged per GB |
| Internet egress | Per GB, tiered; CloudFront is cheaper than origin egress | Per GB, tiered; Front Door has its own rates | Per GB, tiered; Premium vs Standard network tier |
| NoSQL pricing model | Per request or provisioned capacity | Request Units (RU/s) | Per document operation |
| Startup credits | AWS Activate | Microsoft for Startups | Google for Startups Cloud Program |

A few things that catch shops out every year:

- **Cross-zone traffic.** A chatty microservice architecture spread over three zones on AWS or Google Cloud pays for every byte that crosses a zone boundary. Keep the cache and the services that call it zone-aware.
- **NAT and egress for third-party APIs.** Every call to the payment provider, tax service and shipping API leaves through a NAT gateway that bills per GB. It's small per call and large per year.
- **Logging.** Debug-level logs from every pod during a sale can cost more than the pods. All three bill log ingestion per GB.
- **Support.** Production support on any of the three is a percentage of your spend with a monthly minimum. Budget for it; you will want someone to call at 02:00 on Black Friday.

For the same architecture, the three list-price bills usually land within 10 to 20 percent of each other, and the order changes depending on your mix. Discounts, licences you already own, and credits move the number more than the list price does. The only reliable method is to write down your bill of materials (nodes, database size, cache, egress, logs, support) and price it on all three calculators.

## Operational effort

Cost is what you pay the provider. Operational effort is what you pay your own team. For most shops the second number is bigger.

| Area | AWS | Azure | Google Cloud |
|---|---|---|---|
| Identity and access | Most granular, steepest curve (IAM policies, SCPs, roles per pod) | Easiest if you already use Entra ID for staff | Simplest model (org, folders, projects, roles) |
| Networking | VPC per region, Transit Gateway to join them | VNet per region, hub-and-spoke or Virtual WAN | One global VPC across regions, the least to wire |
| Kubernetes | Most choices to make; Auto Mode reduces them | Middle ground; good Azure tooling integration | Most hands-off with Autopilot |
| Managed databases | Widest choice | Best if you are a SQL Server shop | Spanner is unique; AlloyDB is strong |
| Search | OpenSearch, mature and familiar | Azure AI Search, easiest to run | No first-party OpenSearch; Marketplace or self-run |
| Hiring and community | Largest pool of engineers and examples | Strong in enterprises and with .NET teams | Smaller pool, strong in data and Kubernetes |

None of these cells is a dealbreaker. Added up, they tell you which platform your team will fight less.

## Four real scenarios

Theory only goes so far. Here are four situations I've seen, and the choice I'd make in each.

### 1. A five-person D2C startup

A clothing brand with five engineers, 20,000 orders a month, and traffic that jumps 30 times when an influencer posts. No platform team, a small budget, and a lot of nights when nobody is buying.

**Pick: Google Cloud with Cloud Run**, or **AWS with ECS on Fargate** if the team already knows AWS. On Google Cloud: storefront and checkout on Cloud Run with a few minimum instances so the first shopper after a post isn't waiting on a cold start, Cloud SQL for PostgreSQL for orders, Memorystore for sessions, Firestore for carts, Pub/Sub for order events, Cloud CDN and Cloud Armor in front. Nothing to patch, no cluster, and a bill that drops at night.

Two things to get right. Cloud Run can scale to hundreds of instances faster than PostgreSQL can accept connections, so put a connection pooler in front of Cloud SQL and cap max instances to what the database can take. And apply for startup credits on every cloud before deciding; a large credit package often settles the question for the first two years.

### 2. A 400-store retailer moving online sales to the cloud

A retailer with 400 shops, an ERP and a warehouse system on SQL Server, staff signing in with Entra ID, and a Microsoft Enterprise Agreement already in place.

**Pick: Azure.** This is not close. Azure Hybrid Benefit lets them reuse SQL Server and Windows licences they already pay for, which on its own can be worth more than any price difference elsewhere. Staff and admin access uses the Entra ID they already run. AKS for the storefront services, Azure SQL Database Hyperscale for orders, Service Bus with sessions to sync orders to the ERP in order per store, Event Hubs for point-of-sale telemetry from the shops, and Front Door Premium in front. ExpressRoute links the data centre that still runs the warehouse system.

The trap here is Cosmos DB. Teams used to SQL Server tend to write cross-partition queries everywhere and get a large RU bill. Use Azure SQL for anything relational and keep Cosmos DB for carts and sessions with a well-chosen partition key.

### 3. A marketplace scale-up with flash sales

A marketplace with 2 million SKUs, 300 sellers, and flash sales that go from 2,000 to 50,000 requests per second in under a minute. An engineering team of 60 that already runs on AWS.

**Pick: stay on AWS.** Their team already knows it, and AWS has every piece they need. EKS with Karpenter (or Auto Mode) to add nodes fast, with some capacity pre-warmed before each announced sale. Aurora PostgreSQL for orders. DynamoDB for carts and stock reservations, using the conditional write above with stock split across several items per hot SKU. ElastiCache in front of product pages. OpenSearch for search, with the merchandising team tuning synonyms themselves. SQS FIFO for order events, with a message group per order.

Moving this team to another cloud to save 10% would cost a year of roadmap. The better investment is load testing every sale at twice the expected peak.

### 4. A global brand where personalisation is the product

A fashion brand selling in 30 countries whose growth comes from recommendations, personalised search and marketing that reacts to behaviour within minutes.

**Pick: Google Cloud.** Clickstream goes into Pub/Sub and straight into BigQuery through a BigQuery subscription, with no pipeline to maintain. The data team builds models in BigQuery and Google's AI platform, and Google's commerce search ranks products from the same events. The storefront runs on GKE Autopilot behind the global load balancer, which gives one anycast IP for all 30 countries. If they need stock that is strongly consistent across continents, Spanner does it without inventing a reconciliation process.

The trade-off is search tuning. If the merchandisers want to hand-tune ranking rules every week, they will want Elastic Cloud alongside or instead of the managed commerce search.

## Which one to pick, in one diagram

If you take away one picture from this article, take this one. Ask the questions in order; the first "yes" usually decides it.

<figure class="diagram wide"><a href="/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-decision.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-decision.svg" alt="A decision flowchart. Start: new shop or a replatform. Question 1: does the team already run production on one cloud and know it well? Yes leads to 'Stay on that cloud', because skills, landing zone, security reviews and support contracts are already paid for. No leads to question 2: a Microsoft estate with Entra ID, .NET, SQL Server licences and an Enterprise Agreement? Yes leads to Microsoft Azure: AKS or Container Apps, Azure SQL Database, Cosmos DB and Front Door, with Azure Hybrid Benefit for licences. No leads to question 3: fewer than about 10 engineers and no platform team? Yes leads to Google Cloud or AWS serverless: Cloud Run with Cloud SQL and Firestore, or ECS on Fargate with Aurora Serverless v2 and DynamoDB. No leads to question 4: are analytics, recommendations or personalisation the core of the product? Yes leads to Google Cloud with Pub/Sub into BigQuery and Google's recommendation and retail search. No leads to AWS: EKS or ECS, Aurora, DynamoDB, ElastiCache, OpenSearch and CloudFront, for the widest catalog, the biggest hiring pool and the most third-party commerce integrations. Side panels advise keeping the exit door open with Kubernetes or containers, PostgreSQL, the Valkey or Redis protocol, OpenTelemetry, Terraform and a payment service provider; and pricing the same bill of materials on all three calculators before asking for credits." width="1500" height="960" loading="lazy"></a><figcaption>Team skills first, licences second, team size third, data strategy fourth. Price differences come last because they are the smallest.</figcaption></figure>

Notice what isn't on the path: list prices and benchmark charts. They matter, but they almost never flip the answer once the first four questions have one.

## Should a shop be multi-cloud?

Usually not on purpose. Running the same storefront actively on two clouds doubles your platform work and halves your depth on each. It doesn't protect you from the failures that actually take shops down, which are bad deploys, exhausted database connections and expired certificates.

Multi-cloud does happen for good reasons: you acquire a brand that runs on another cloud, your data team is on BigQuery while the shop runs on AWS, or a regulator wants an exit plan. In those cases connect the clouds privately and deliberately, as described in [connecting AWS and Google Cloud for a large enterprise](/blog/aws-gcp-multicloud-networking/), and keep each workload on one side.

What you should do on every cloud is keep the exit door open, because it costs almost nothing:

- Run services in containers, ideally on Kubernetes.
- Use PostgreSQL rather than a proprietary SQL dialect where you can.
- Talk to the cache over the Valkey or Redis protocol.
- Instrument with OpenTelemetry, not a vendor SDK.
- Build everything with Terraform. The [module architecture guide](/blog/terraform-best-practices-module-architecture/) and the enterprise guides for [AWS](/blog/terraform-aws-enterprise-guide/), [Google Cloud](/blog/terraform-google-cloud-enterprise-guide/) and [Azure](/blog/terraform-azure-enterprise-guide/) show how.
- Take payments through a payment service provider, never a cloud-specific service.

## The short version

- **Already on a cloud and good at it?** Stay. Spend the migration budget on load testing and checkout resilience.
- **Microsoft shop with SQL Server licences?** Azure, and claim Hybrid Benefit.
- **Small team, spiky traffic, little ops capacity?** Serverless containers: Cloud Run on Google Cloud, or Fargate on AWS. Take the biggest credit offer.
- **Data and personalisation are the strategy?** Google Cloud, built around BigQuery.
- **Everything else, especially a growing team that wants the most options and the most people who've done it before?** AWS.

## Download the diagrams

All three diagrams are editable draw.io files using the official AWS, Azure and Google Cloud shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the services to match your own stack.

- [All three diagrams in one file (3 pages)](/assets/diagrams/aws-azure-gcp-ecommerce/aws-azure-gcp-ecommerce.drawio)
- [The e-commerce service map](/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-service-map.drawio)
- [One storefront, three clouds](/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-storefront.drawio)
- [Which cloud for which shop: decision path](/assets/diagrams/aws-azure-gcp-ecommerce/ecommerce-decision.drawio)

Service names are as of November 2026, and all three providers rename things often. Check current prices, quotas and regional availability for your own regions before you commit.

## References

- [AWS pricing calculator](https://calculator.aws/)
- [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/)
- [Google Cloud pricing calculator](https://cloud.google.com/products/calculator)
- [Amazon EKS pricing](https://aws.amazon.com/eks/pricing/)
- [AKS pricing tiers](https://learn.microsoft.com/azure/aks/free-standard-pricing-tiers)
- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)
- [DynamoDB condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html)
- [Azure Cosmos DB partial document update](https://learn.microsoft.com/azure/cosmos-db/partial-document-update)
- [Azure Managed Redis overview](https://learn.microsoft.com/azure/redis/overview)
- [Azure Cache for Redis retirement FAQ](https://learn.microsoft.com/azure/azure-cache-for-redis/retirement-faq)
- [Azure availability zones and inter-zone data transfer](https://learn.microsoft.com/azure/reliability/availability-zones-overview)
- [Azure Front Door tier comparison](https://learn.microsoft.com/azure/frontdoor/standard-premium/tier-comparison)
- [Azure Service Bus message sessions](https://learn.microsoft.com/azure/service-bus-messaging/message-sessions)
- [Pub/Sub BigQuery subscriptions](https://cloud.google.com/pubsub/docs/bigquery)
- [Firestore best practices](https://firebase.google.com/docs/firestore/best-practices)
- [Spanner overview](https://cloud.google.com/spanner/docs/overview)
- [Azure Hybrid Benefit](https://azure.microsoft.com/pricing/offers/hybrid-benefit/)
