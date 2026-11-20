---
title: "E-commerce on AWS: a reference architecture that survives an AZ outage and a flash sale"
description: "A multi-AZ reference architecture for an online store on AWS: CloudFront and WAF at the edge, EKS behind an ALB, Aurora, DynamoDB, ElastiCache, OpenSearch, SQS and EventBridge. Walked through two real scenarios, an Availability Zone going bad and a 20x flash sale, with four editable draw.io diagrams."
date: 2026-11-20T04:05:00Z
category: Cloud & DevOps
coverLabel: "E-commerce\non AWS that\nstays up."
coverCode: "3 AZs · 0 lost orders"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-ecommerce-reference-architecture.jpg
coverImageAlt: "Cloud & DevOps cover reading 'E-commerce on AWS that stays up.', with the AWS logo."
---
Most online stores don't fall over on a normal Tuesday. They fall over at 12:00 on the day of the big sale, or at 20:14 on a Friday when one data centre in the region starts dropping packets. Both are predictable. Both are the days that pay for the year.

This article is the AWS architecture I'd start from for a store doing somewhere between a few hundred and a few thousand orders a minute at peak. It isn't the only way to do it, but every piece is there for a reason, and I'll show the reason by walking through two scenarios that actually happen: an Availability Zone going bad in the middle of trading, and a flash sale that brings twenty times the normal traffic in ninety seconds.

There are four diagrams, each one an editable `.drawio` file built with draw.io's own AWS shapes. You can download them at the end.

<figure class="diagram wide"><a href="/assets/diagrams/aws-ecommerce/aws-ecommerce-hld.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-ecommerce/aws-ecommerce-hld.svg" alt="High-level design. Shoppers on web and mobile resolve the shop through Route 53 and connect to CloudFront, which sits in a global edge group with AWS WAF, Shield Advanced and ACM. CloudFront serves product images and static files from an S3 bucket through origin access control, and sends dynamic requests through the internet gateway of a VPC (10.20.0.0/16) in us-east-1. The VPC spans three Availability Zones. Each AZ has a public subnet with an ALB node and a NAT gateway, a private app subnet with EKS nodes managed by Karpenter running storefront, catalog, cart, checkout, orders and payments pods, and a private data subnet with an Aurora instance (writer in AZ a, readers in AZ b and c), an ElastiCache Valkey node (primary in AZ a, replicas in b and c) and an OpenSearch data node. A band across the data subnets says the Aurora cluster volume keeps six copies of every page across three AZs. To the right, regional managed services reached through VPC endpoints: DynamoDB for carts and sessions, SQS order queues and dead-letter queues, EventBridge order events bus, Lambda async workers, Cognito, Secrets Manager, KMS, ECR, CloudWatch and SES." width="1610" height="1000" loading="lazy"></a><figcaption>The high-level design: one region, three AZs, stateless services on EKS, managed data stores, and everything slow or optional pushed onto queues.</figcaption></figure>

## The short version

- **Three AZs, sized so two can carry the whole load.** Run each AZ at no more than about 66% at peak. That is the single most important number in this article.
- **Cache everything you can at the edge.** CloudFront in front of both the static site and the API. A product page that is 5 seconds stale is fine. A product page that times out is not.
- **Keep the services stateless.** Pods on EKS (or tasks on ECS) hold nothing that matters. State lives in Aurora, DynamoDB and ElastiCache, which all handle their own replication across AZs.
- **Pick the database per job.** Aurora for orders, payments and stock, where you need transactions. DynamoDB for carts and sessions, where you need scale and simple keys. OpenSearch for search, never as a source of truth.
- **One transaction, then events.** Checkout writes the order, the stock reservation and an outbox row in a single Aurora transaction. Everything after that, emails, fulfilment, search updates, loyalty points, runs off events and queues.
- **Make every write idempotent.** Retries are how distributed systems survive failures. Without idempotency keys, retries are how you charge a customer twice.
- **Practise the bad day.** Zonal shift, Aurora failover and a load test at twice the forecast are things you run on purpose, before you need them.

## The pieces, and why each one is there

### Edge: Route 53, CloudFront, WAF, Shield

Shoppers resolve the shop through **Route 53**, which also health-checks the origin, so a later move to a second region is a DNS change rather than a project.

Everything then goes through **CloudFront**, not only images. The product page HTML, the category listings and even the price and stock JSON can be cached for a few seconds with `stale-while-revalidate`. On a normal day that's a nice latency win. On sale day it decides whether your origin sees 120,000 requests a second or 7,000.

**AWS WAF** sits on the CloudFront distribution with the managed core rule set, Bot Control, and rate-based rules on the endpoints scalpers love, `/cart` and `/checkout`. **Shield Advanced** is worth its monthly fee for a store of this size, mostly for the DDoS response team and the cost protection, which credits you for the scaling a DDoS forces on you.

The ALB only accepts traffic from CloudFront. Use the CloudFront managed prefix list in the ALB security group, and add a secret header that CloudFront sends and a listener rule checks, so nobody can go around the edge by hitting the ALB directly.

### Compute: EKS behind an ALB

The services, storefront, catalog, cart, checkout, orders and payments, run as pods on **Amazon EKS** with **Karpenter** choosing and launching nodes. One ALB, created by the AWS Load Balancer Controller, has a node in each public subnet and sends traffic straight to pod IPs.

A few settings matter more than the rest:

- **`topologySpreadConstraints` on `topology.kubernetes.io/zone`**, so replicas really are spread across the three AZs. Without it the scheduler happily puts all six checkout pods in one zone.
- **PodDisruptionBudgets** on every service, so a node upgrade or a Karpenter consolidation never takes out more than one replica at a time.
- **Readiness probes that check what the pod needs to serve**, and liveness probes that don't. I've written about [why those two fail so differently](/blog/kubernetes-readiness-vs-liveness/).

If your team doesn't want to run Kubernetes, **ECS on Fargate** works for this architecture with almost no changes: services behind the same ALB, capacity spread across the same three subnets, scaling on the same metrics. You lose Karpenter's bin-packing and the Kubernetes ecosystem. You also lose a control plane to upgrade. For a team of five, that trade is often worth it.

For the full path a request takes from the internet into a pod, every security group, NACL and hop on the way, see [From the internet to an EKS pod](/blog/aws-eks-request-path/).

### Data: one store per job

This is where most e-commerce designs go wrong, usually by putting everything in one big relational database or, in the other direction, by putting orders in a key-value store and rebuilding transactions by hand.

| Data | Store | Why |
| --- | --- | --- |
| Orders, order lines, payments, stock | **Aurora PostgreSQL** | Needs transactions and constraints. Writer plus two readers across three AZs, storage replicated six ways. |
| Carts, sessions, wishlists | **DynamoDB** (on-demand) | Huge write volume, simple key lookups, scales without warning you. Global tables if you go multi-region later. |
| Hot reads, price cache, sale stock counters | **ElastiCache (Valkey)** | Sub-millisecond reads, atomic counters, cluster mode with a replica in each AZ. |
| Product search, facets, typo tolerance | **OpenSearch Service** | Built for search. Fed from events, rebuilt from Aurora if needed, never the source of truth. |
| Product images, exports, invoices | **S3** | Served through CloudFront with origin access control. |

Two details that save pain later. Put **RDS Proxy** between the pods and Aurora, because a few hundred pods with a connection pool each will exhaust Aurora's connections at exactly the wrong moment, and the proxy also shortens failovers. And reach DynamoDB, S3, SQS and the rest through **VPC endpoints**, gateway endpoints for S3 and DynamoDB, interface endpoints for everything else, so service traffic doesn't pay NAT gateway processing charges or depend on them.

### Async: SQS and EventBridge

Anything that doesn't have to happen before you tell the shopper "thank you" happens later, on a queue. Sending the confirmation email, telling the warehouse, updating stock in the search index, awarding loyalty points, feeding analytics.

**EventBridge** carries business events like `OrderPlaced` and `OrderCancelled` on a custom bus. Each consumer gets its **own SQS queue** behind its own rule, so a slow or broken consumer only backs up its own queue. Every queue has a dead-letter queue, and every DLQ has an alarm.

## Checkout, step by step

Checkout is the one flow where you can't be sloppy. It touches money and stock, it gets retried by browsers, mobile apps and your own code, and it runs at its busiest when everything else is busiest too.

<figure class="diagram wide"><a href="/assets/diagrams/aws-ecommerce/aws-ecommerce-checkout.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-ecommerce/aws-ecommerce-checkout.svg" alt="Checkout low-level design with eight numbered steps. 1: a shopper sends POST /orders through CloudFront and WAF to the ALB and the checkout service on EKS. 2: checkout calls the cart service, which reads the carts table in DynamoDB, and the pricing service, which reads prices and stock counters from ElastiCache Valkey. 3: checkout runs one database transaction through RDS Proxy on Aurora PostgreSQL: insert the order and order lines, update inventory to reserve the quantity only where on-hand minus reserved is enough, insert an outbox row of type OrderPlaced, and commit. 4: checkout authorises payment with the external payment provider through the NAT gateway, using the order id as the idempotency key, with a 3 second timeout and one retry before marking the payment pending. 5: an outbox relay reads unsent rows from Aurora and publishes OrderPlaced to an EventBridge orders bus. 6: one rule per consumer sends the event to four SQS queues. 7: fulfilment workers on EKS scaled by KEDA on queue depth, a Lambda that sends the confirmation through SES, a Lambda that updates stock in OpenSearch, and a Lambda that awards loyalty points in DynamoDB. 8: every queue has a dead-letter queue after five receives, an alarm on the age of the oldest message, and consumers record processed order and event ids so retries are harmless." width="1600" height="900" loading="lazy"></a><figcaption>Checkout does one transaction and one payment call synchronously. Everything else runs off the outbox.</figcaption></figure>

1. **The client sends `POST /orders` with an `Idempotency-Key` header**, generated once when the shopper lands on the payment page. If the request is retried, by a flaky mobile connection or a double click, checkout finds the existing order for that key and returns it.
2. **Read the cart and re-price every line.** Never trust a price the browser sends. The pricing service reads from ElastiCache and falls back to Aurora.
3. **One Aurora transaction** inserts the order, reserves the stock and writes an outbox row. The stock reservation is a single conditional update:

   ```sql
   UPDATE inventory
      SET reserved = reserved + :qty
    WHERE sku = :sku
      AND on_hand - reserved >= :qty;
   ```

   If it updates zero rows, the item is gone, and the transaction rolls back. The check and the write are the same statement, so two shoppers can never buy the last unit.
4. **Authorise the payment** with the provider, passing the order id as their idempotency key. Give the call a short timeout. If the provider is slow, mark the order "payment pending" and let a worker finish it, instead of holding a checkout pod for 30 seconds.
5. **An outbox relay publishes `OrderPlaced`** to EventBridge and marks the row sent. This is the transactional outbox pattern: the event exists if and only if the order committed. No more orders with no confirmation email, or emails for orders that rolled back.
6. **EventBridge rules fan the event out** to one SQS queue per consumer.
7. **Consumers work at their own pace.** Fulfilment workers on EKS scale with KEDA on queue depth. Small jobs like email run on Lambda.
8. **Consumers are idempotent.** SQS delivers at least once, so each consumer records the event id it processed and skips repeats. Messages that fail five times go to a DLQ, and an alarm on `ApproximateAgeOfOldestMessage` tells you a consumer is stuck long before customers do.

## Scenario 1: an Availability Zone goes bad

It's 20:14 on a Friday. One AZ in your region starts dropping a few percent of packets and adding a couple of seconds of latency. It isn't down. Instances still answer some health checks. This "gray failure" is the common case, and it's nastier than a clean outage because nothing fails over by itself.

<figure class="diagram wide"><a href="/assets/diagrams/aws-ecommerce/aws-ecommerce-az-failure.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-ecommerce/aws-ecommerce-az-failure.svg" alt="AZ failure scenario. Three AZ columns under an ALB with cross-zone load balancing and zonal shift enabled, plus ARC zonal autoshift. AZ b is marked impaired: its EKS nodes are NotReady with pods evicted, and its Aurora writer, Valkey primary, OpenSearch node and NAT gateway are lost. The ALB sends 0% to AZ b after a zonal shift. AZ a and AZ c each get new Karpenter nodes for replacement pods; the Aurora reader in AZ a is promoted to writer and the Valkey replica in AZ c is promoted to primary; OpenSearch continues with the standby AZ. A timeline on the right: T+0 AZ b starts dropping packets and p99 checkout latency jumps; T+1 minute a zonal shift sets AZ b to 0% and errors stop; T+1 minute Aurora promotes the reader in AZ a while RDS Proxy holds connections; T+2 minutes ElastiCache promotes the replica in AZ c and DynamoDB is unaffected; T+2 to 6 minutes nodes in AZ b go NotReady, pods are evicted after 60 seconds and Karpenter starts nodes in AZ a and c; T+6 minutes all replicas run in two AZs with no orders lost; afterwards end the shift, let Karpenter consolidate and rebalance." width="1600" height="900" loading="lazy"></a><figcaption>Every layer has its own failover. The architecture's job is to make each one fast and boring.</figcaption></figure>

Here's what happens, and what has to be true beforehand for it to go well.

**The load balancer stops sending traffic to AZ b.** ALB health checks catch the worst targets, but with a gray failure they flap. This is what **zonal shift** in Amazon Application Recovery Controller is for: one API call, or the on-call engineer pressing a button, and the ALB sends nothing to that AZ for as long as you say. Turn on **zonal autoshift** and AWS does it for you when its own telemetry sees an AZ in trouble. Autoshift requires that you've proved you can run without one AZ, which is the point: it comes with practice runs that shift your traffic away on a schedule, so you find out on a quiet Wednesday, not on a busy Friday.

**The two remaining AZs carry all the traffic.** This only works if they have room. If each AZ runs at 66% at peak, losing one takes the others to about 100%, and HPA plus Karpenter add capacity over the next few minutes. If each AZ was running at 90%, you've just lost a third of your capacity and the rest falls over. This is called static stability: you don't need to launch anything to survive the failure, you only launch things to get your headroom back.

**Aurora fails over.** If the writer was in AZ b, Aurora promotes a reader in another AZ, usually within about a minute. The storage volume doesn't move, it was already in all three AZs. RDS Proxy keeps the client connections open and routes them to the new writer, so the pods see a pause rather than a flood of connection errors. Make sure your readers are the same instance size as the writer, or failover leaves you with a writer that can't handle the load.

**ElastiCache promotes a replica.** With Multi-AZ and automatic failover on, the replica in another AZ becomes primary. For a few seconds some cache reads miss and go to DynamoDB or Aurora, which is why the cache must be an optimisation and never the only copy of anything.

**DynamoDB, SQS, EventBridge, S3 and Lambda don't notice.** They're regional services that already spread themselves across AZs. That's a real reason to prefer them for the parts of the system that can use them.

**Pods get replaced.** Nodes in AZ b go `NotReady`. By default Kubernetes waits 300 seconds before evicting pods from a node it can't reach. Set `tolerationSeconds` on the `node.kubernetes.io/unreachable` and `not-ready` tolerations to something like 60 for your stateless services, and replacements start much sooner. Karpenter launches new nodes in the healthy AZs. Make sure your topology spread uses `whenUnsatisfiable: ScheduleAnyway` for this reason; with `DoNotSchedule`, pods wait for a zone that isn't coming back.

**NAT is per AZ.** Each private subnet routes to the NAT gateway in its own AZ. If you shared one NAT gateway across all AZs to save money, it would be a single point of failure for every outbound call, including the one to your payment provider.

**What customers saw:** a minute or two of slow checkouts and a small number of errors, which their apps retried with the same idempotency key. No lost orders, no double charges.

## Scenario 2: the flash sale

Marketing has announced a sale at 12:00. Last year it brought 20 times normal traffic in 90 seconds. Here is how each layer is set up so that the one behind it sees less load, at a steadier rate.

<figure class="diagram wide"><a href="/assets/diagrams/aws-ecommerce/aws-ecommerce-flash-sale.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-ecommerce/aws-ecommerce-flash-sale.svg" alt="Flash sale scenario as a pipeline with requests per second at the peak above each stage: shoppers 120,000; CloudFront 7,200 to origin with pages and 5-second price JSON cached and 94% served at the edge; AWS WAF 6,000 with Bot Control and rate-based rules on cart and checkout; a waiting room using a CloudFront Function that checks signed admission tokens issued by Lambda at 400 checkouts a second; ALB plus EKS at 6,000 with minimum replicas raised before the sale and Karpenter adding nodes; ElastiCache Valkey at 45,000 operations with a Lua script decrementing sale stock and refusing below zero; SQS order intake at 400 in and 400 out with checkout returning 202 once the message is queued; and the Aurora writer at a flat 400 transactions a second. A bar chart shows the share of the peak reaching each layer: edge 100%, origin 6%, after WAF 5%, checkout admitted and Aurora writes 0.33%. A run-up checklist runs from a load test at T minus 7 days to putting the minimums back at T plus 2 hours. A box lists five lessons from last year: checkout writing straight to Aurora ran out of connections, a SELECT then UPDATE stock check oversold, Karpenter needed 3 minutes for nodes, the CDN cached a 503 for 60 seconds, and nobody alarmed on queue age." width="1600" height="830" loading="lazy"></a><figcaption>Each layer shrinks the load and smooths it. Aurora sees a flat 400 writes a second while the edge takes 120,000 requests.</figcaption></figure>

**The edge absorbs the reads.** Most people on a sale page never buy. They refresh the product page and watch the stock badge. With the product page cached for a few seconds and the price and stock JSON cached for 5 seconds, CloudFront answers about 94% of requests itself. Use origin shield so that cache misses from hundreds of edge locations collapse into a handful of requests to your origin.

**WAF removes the bots.** Bot Control plus a rate-based rule on cart and checkout endpoints. Scalpers get a 429 or a CAPTCHA, and real shoppers get the stock.

**A waiting room admits checkouts at a fixed rate.** A CloudFront Function checks a signed admission token on checkout routes. A small Lambda issues tokens at the rate your back end can handle, say 400 a second, and everyone else sees a "you're in the queue" page that polls. It feels worse than instant, but it's fair and it's much better than a 503.

**EKS is scaled before the sale, not during it.** HPA reacts in tens of seconds and Karpenter needs about a minute for a new node, which is too slow for a spike that peaks in 90 seconds. Raise `minReplicas` at 11:30 and run a few low-priority "pause" pods that hold spare node capacity: when real pods need the space, they evict the pause pods and start immediately.

**Stock for the sale item lives in ElastiCache.** A Lua script checks and decrements the counter in one atomic step and refuses when it reaches zero. That's what stops you overselling 500 TVs when you have 200. The order still gets written to Aurora, which stays the system of record; the counter is just the fast gate in front of it.

**Order writes go through a queue.** Checkout puts the order on an SQS queue and returns "order received". Workers drain the queue at a concurrency you choose, so Aurora sees a flat 400 transactions a second whether shoppers click at 400 a second or 4,000. The shopper gets a confirmation a few seconds later. This is the biggest single change for sale days, and it's only safe because the work is idempotent.

**DynamoDB carts are warmed.** On-demand tables scale fast, but not instantly from a quiet baseline. Set warm throughput on the carts table the day before.

### The run-up checklist

| When | What |
| --- | --- |
| T-7 days | Load test at twice the forecast peak, with the real WAF rules and the waiting room on. |
| T-3 days | Request limit increases: Lambda concurrency, EC2 vCPU quotas for Karpenter's instance types, and anything else the load test got close to. |
| T-1 day | Add Aurora readers, set DynamoDB warm throughput, check CloudFront cache hit ratio on the sale pages. |
| T-30 min | Raise HPA minimums and pause pod headroom. Warm the caches. Put the on-call engineers in one channel. |
| T-0 | Watch p99 checkout latency, 5xx at the ALB, queue age, ElastiCache CPU and Aurora commit latency. Not average CPU. |
| T+2 hours | Put the minimums back and let Karpenter consolidate. |

## Things that bite

- **Caching errors.** CloudFront caches a 503 for 10 seconds by default unless you change it. Set short error-caching TTLs, and add an origin failover group pointing at a static "sold out, back soon" page in S3.
- **Retries without jitter.** When Aurora pauses for a failover, every pod retries at the same instant and the new writer gets hit by a thundering herd. Exponential backoff with jitter, everywhere.
- **Cross-AZ data transfer.** Traffic between AZs costs money in both directions. Cross-zone load balancing, replication and chatty services add up. Keep it in mind, but don't give up multi-AZ to save it.
- **Search as a source of truth.** If the product page reads stock from OpenSearch, it will be wrong whenever the indexer lags. Read stock from the cache or the database.
- **One NAT gateway.** Cheap until the AZ it lives in has a bad day.
- **Untested failover.** If you've never run an Aurora failover or a zonal shift in production, you don't know how long it takes. Run AWS Fault Injection Service experiments on a schedule and write the numbers down.

## When this is too much, or not enough

For a new store doing a few orders a minute, this is overkill. Start with ECS on Fargate or App Runner, Aurora Serverless v2, DynamoDB and CloudFront. Keep the same habits: idempotent checkout, an outbox, three AZs. The habits are what you can't easily add later.

For a store that can't accept a regional outage, the next step is a second region: Aurora Global Database, DynamoDB global tables, ElastiCache global datastore, S3 replication and Route 53 failover. That roughly doubles the bill and the operational work, so decide it from your actual revenue per hour of downtime, not by default.

Building the AWS accounts and VPCs for this with Terraform? I've covered [how to structure Terraform across many AWS accounts](/blog/terraform-aws-enterprise-guide/).

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change them to fit your own system.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-ecommerce/aws-ecommerce-reference-architecture.drawio)
- [Reference architecture (HLD)](/assets/diagrams/aws-ecommerce/aws-ecommerce-hld.drawio)
- [Checkout and order events](/assets/diagrams/aws-ecommerce/aws-ecommerce-checkout.drawio)
- [Scenario: an AZ fails](/assets/diagrams/aws-ecommerce/aws-ecommerce-az-failure.drawio)
- [Scenario: flash sale](/assets/diagrams/aws-ecommerce/aws-ecommerce-flash-sale.drawio)

The CIDRs, instance sizes, timings and traffic numbers are examples. Measure your own in a load test and a game day before you rely on them.

## References

- [AWS Well-Architected Framework: Reliability pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
- [Zonal shift and zonal autoshift in Amazon Application Recovery Controller](https://docs.aws.amazon.com/r53recovery/latest/dg/arc-zonal-shift.html)
- [Static stability using Availability Zones (Amazon Builders' Library)](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/)
- [Making retries safe with idempotent APIs (Amazon Builders' Library)](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
- [Transactional outbox pattern (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [Amazon Aurora high availability](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html)
- [Restricting access to Application Load Balancers through CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html)
- [Virtual Waiting Room on AWS](https://aws.amazon.com/solutions/implementations/virtual-waiting-room-on-aws/)
