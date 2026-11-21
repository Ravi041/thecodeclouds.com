---
title: "Multi-region active-active on AWS with an RTO under one minute"
description: "How to run one application from two AWS Regions at the same time and lose either of them in under a minute: Global Accelerator and Route 53 for traffic, DynamoDB global tables (strong and eventual consistency) and Aurora Global Database for data, honest health checks, conflict handling, and the failover tests that prove the numbers. Requirements, Well-Architected mapping, five production scenarios and four editable draw.io diagrams."
date: 2026-11-21T03:02:00Z
category: Cloud & DevOps
coverLabel: "Two Regions.\nBoth live.\nRTO < 60 s."
coverCode: "RTO < 60 s · RPO 0 for money"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-multi-region-active-active.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Two Regions. Both live. RTO < 60 s.', with the AWS logo."
---
Most "multi-region" architectures I review are really one Region plus a hope. There is a second Region on the diagram, the database replicates into it, and the runbook says "fail over". Then someone asks how long that takes, and the honest answer is twenty minutes on a good day, after a call where four people agree the primary is really gone.

Active-active is the other end of the scale. Both Regions take real traffic all the time, so there is nothing to "bring up" when one of them breaks. You stop sending traffic to the broken one and the other carries on. Done well, customers see a few failed requests and a retry. Done badly, you get two Regions that disagree about how much money a customer has.

This article is the design I'd use when the requirement is a recovery time under one minute. The running example is a consumer wallet app: people check balances, pay merchants and send money to friends. That makes the trade-offs sharp, because some data can be a little stale and some data can never be wrong. The services are AWS-native, the numbers are realistic, and the four diagrams are editable `.drawio` files built with the AWS shapes that ship with draw.io.

## The short version

- **Route traffic with anycast, not DNS TTLs.** AWS Global Accelerator gives clients two static IP addresses and moves new connections away from an unhealthy Region in seconds, with no DNS caches in the way. Route 53 only points the name at the accelerator.
- **Size each Region for all of the traffic.** If a Region failure means "scale up the survivor", your RTO now depends on how fast EC2 or Fargate can launch capacity in a stressed Region. Pre-provision instead. That is static stability.
- **Split your data by what a conflict would cost.** Money goes in a DynamoDB global table with multi-Region strong consistency (MRSC), so there is no double spend and the RPO is zero. User state goes in an eventually consistent global table (MREC) designed so that last-writer-wins can't hurt. Relational back-office data stays single-writer on Aurora Global Database, off the payment path.
- **Make health checks tell the truth.** A shallow `/health` that returns 200 while every payment fails is the most common reason active-active doesn't fail over.
- **Keep control planes out of the failover path.** Health-check-driven shifts in Global Accelerator are data-plane behaviour. Editing DNS records or calling APIs that live in one Region during an outage is not.
- **Prove it every month.** AWS Fault Injection Service (FIS) experiments with stop conditions, outside-in canaries and a written hypothesis. An RTO you haven't measured is a guess.

## Requirements

Write these down before you draw anything. Active-active costs roughly twice what a single Region costs, so the requirements have to justify it, and they should be specific enough to test.

### The example workload

- A wallet app with 8 million registered users in North America, about 1.2 million daily actives.
- Peak load of 6,000 API requests per second, of which 900 are writes that move money (payments, transfers, top-ups).
- Mobile and web clients, all talking to one API hostname, `api.wallet.example`.
- A regulated product: every money movement is auditable and a customer's balance must never be wrong, even for a second.

### Functional requirements

1. Customers can check their balance, pay and send money from either Region at any time.
2. A payment retried by the client (timeout, app restart, failover) is applied exactly once.
3. Profile and preference changes made on one device show up on others within a few seconds.
4. Back-office staff can update KYC records, merchant settings and settlements.

### Non-functional requirements

| Requirement | Target | Why this number |
|---|---|---|
| RTO for pay, transfer and balance | < 60 seconds after a Regional failure starts | Card-present payments time out in about 30 seconds; a longer outage shows up in merchant complaints |
| RPO for balances and payments | 0 | A lost payment is a regulatory incident, not a bug |
| RPO for profiles and sessions | < 5 seconds | Losing a language preference is annoying, not harmful |
| RTO / RPO for back-office writes | < 15 minutes / < 5 seconds | Staff can wait; customers can't |
| Availability of the pay API | 99.99% monthly (about 4.3 minutes of downtime) | Two Regions, each 99.9%+, with fast independent failover |
| Latency | p99 < 300 ms for balance reads, < 500 ms for payments | Measured at the client, including the cross-Region commit for writes |
| Capacity | Either Region alone handles 100% of peak plus 20% headroom | No scale-up on the critical path during a failover |
| Failover decision | Automatic for traffic; a human approves database writer moves | Automate what is safe to automate; keep judgement for what isn't |
| Testing | Monthly game day with at least one fault injected in production | Untested failover paths decay with every release |
| Cost ceiling | Under 2.3× the single-Region run rate | The business agreed to pay for resilience, within limits |

### Non-goals

- Surviving a failure of the whole AWS partition or of a global service. That is a different design, with a different budget.
- Active-active for analytics, reporting or batch jobs. They run in one Region and can restart elsewhere.
- Data residency across countries. Both Regions here are in the US.

### When active-active is the wrong answer

If your RTO is 15 minutes, a warm standby is cheaper and simpler: one Region serves, the other has data and a small fleet, and you scale up during a failover. If your RTO is hours, pilot light or backup and restore are fine. The [disaster recovery whitepaper](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html) covers all four strategies. Active-active only earns its cost when the RTO is measured in seconds or a minute, or when you need both Regions for latency anyway.

## The architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-region-active-active/active-active-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-region-active-active/active-active-reference.svg" alt="Active-active reference architecture. Wallet app users resolve api.wallet.example in Route 53, which is an alias to AWS Global Accelerator; the DNS answer is static, so there is no TTL wait on failover. Users connect to Global Accelerator, which has two static anycast IP addresses on TCP 443 (step 1). Global Accelerator has one endpoint group per Region, each with traffic dial 100 percent (step 2), pointing at an internal Application Load Balancer with endpoint weight 128 in us-east-1 and us-west-2. Each Region is serving 50 percent of traffic. Behind each ALB, ECS on Fargate runs the wallet-api, transfers and profile services, pre-scaled to 100 percent of peak (step 3). Tasks reach every data store in their own Region over VPC endpoints. In each Region there are five stores: ElastiCache for Valkey as a local cache that is not replicated; a KMS multi-Region key with Secrets Manager, replicated as replica keys and replica secrets; Aurora PostgreSQL, the global primary writer in us-east-1 and a secondary with reads and write forwarding in us-west-2, joined by Aurora Global Database storage replication of about one second; a profiles DynamoDB global table using multi-Region eventual consistency, async replication of about one second with last writer wins; and a ledger DynamoDB global table using multi-Region strong consistency, a synchronous quorum with RPO zero. A third Region, us-east-2, holds only the ledger witness, which votes in the quorum and serves no traffic (step 4). CloudWatch Synthetics canaries probe the accelerator from three Regions by paying and reading a balance, and an ARC Region switch plan covers planned evacuation and the Aurora failover runbook. A side box summarises what fails over: traffic moves when an ALB endpoint is unhealthy, the ledger keeps writing with any two of three Regions, profiles are always writable on both sides, and Aurora writes need a managed failover measured in minutes." width="1500" height="980" loading="lazy"></a><figcaption>Two serving Regions behind one accelerator, a witness Region for the ledger, and a different replication model per kind of data. Numbers match the steps below.</figcaption></figure>

1. **Route 53 and Global Accelerator.** `api.wallet.example` is an alias record pointing at the accelerator. The accelerator advertises two static anycast IPv4 addresses from AWS edge locations, so a client in Denver enters the AWS network close to home and rides the AWS backbone to a Region. The DNS answer never changes during a failover, so client and resolver caches don't matter.
2. **One endpoint group per Region.** Each group has a traffic dial (the percentage of traffic that group is allowed to take, 100% by default) and holds one endpoint: an internal ALB. Global Accelerator sends each client to the closest healthy endpoint group. If the us-east-1 ALB becomes unhealthy, new connections go to us-west-2. The ALBs have no public IPs; Global Accelerator reaches them privately and preserves the client IP.
3. **Compute that doesn't need to scale to survive.** ECS services on Fargate run the API in both Regions with the same task definitions, deployed by the same pipeline. Each Region runs enough tasks for 100% of peak (more on the maths below). Every service has an `/health/ready` endpoint that the ALB target group checks every 5 seconds.
4. **Data in three shapes.** The ledger (balances, holds, idempotency keys) is a DynamoDB global table in MRSC mode across us-east-1 and us-west-2, with a witness in us-east-2. Profiles and sessions are an MREC global table. Back-office data is Aurora PostgreSQL Global Database with its writer in us-east-1. ElastiCache is deliberately not replicated: each Region warms its own cache from its own tables.
5. **Supporting pieces replicated ahead of time.** KMS multi-Region keys so ciphertext written in one Region decrypts in the other, Secrets Manager replica secrets, and ECR replication so images are already in both Regions when a deployment or a scale-out needs them.

### Why Global Accelerator instead of Route 53 failover

Route 53 can do active-active too, with latency-based or weighted records and health checks. The problem is time. Here is the arithmetic for both, with the most aggressive settings each offers.

| Step | Route 53 latency records + health checks | Global Accelerator + ALB health |
|---|---|---|
| Detect | Fast health checks: 10 s interval × failure threshold 3 ≈ 30 s | ALB target group: 5 s interval × unhealthy threshold 2 ≈ 10 s |
| Stop routing to the bad Region | Route 53 stops returning the record within seconds of the health check failing | Global Accelerator moves new flows within seconds |
| Clients notice | Only after their cached answer expires: TTL 60 s, and some clients cache longer | Immediately: the IP addresses don't change |
| Realistic total | 90 s to several minutes, long tail from client caches | 15 to 30 s |

You can drop the Route 53 TTL to 10 seconds, but you'll still see a tail of clients (older JVMs, some mobile resolvers, corporate proxies) that hold on to the old answer much longer. With anycast there's nothing to cache. That one difference is most of the reason this design can promise under a minute.

Route 53 is still useful here: it hosts the zone and the alias, it runs health checks you can alarm on, and for workloads that aren't TCP or UDP behind a load balancer it remains the right tool. If you do use DNS failover, drive it with [ARC routing controls](https://docs.aws.amazon.com/r53recovery/latest/dg/routing-control.html) rather than by editing records in a crisis.

### Keep control planes out of the failover path

Every AWS service has a control plane (the APIs that create and change things) and a data plane (the part that serves your traffic). Data planes are built to keep working when control planes are impaired. The [AWS Fault Isolation Boundaries whitepaper](https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/abstract-and-introduction.html) explains this in detail, and it matters here because two of the services in this design have their control plane in a single Region:

- **Route 53**'s control plane is in us-east-1. Changing a record during a us-east-1 event is exactly the kind of call you shouldn't depend on. Health checks and DNS answers are data plane and keep working.
- **Global Accelerator**'s API lives in us-west-2. Changing a traffic dial is a control-plane call. Automatic failover from health checks is not.

So the automatic path, an endpoint going unhealthy and traffic moving, uses only data planes. The traffic dial is for planned work: draining a Region before a risky change, or evacuating one that is slow but not failing. If us-west-2 is the Region in trouble and you can't reach the API, the health-check path still works on its own, which is one more reason to make sure your health checks tell the truth.

### Health checks that tell the truth

Global Accelerator treats an ALB endpoint as healthy based on the ALB's own target health. That means your target group health check decides whether a whole Region gets traffic. Two classic mistakes:

- **Too shallow.** `/health` returns 200 if the process is up. DynamoDB in that Region is throwing errors, every payment fails, and the Region stays "healthy".
- **Too deep.** Every health check calls every dependency. One slow dependency, or a dependency shared by both Regions, marks every target unhealthy everywhere at once.

What works for me is a readiness endpoint that reports on things that are local to the Region and that the service can't work without, using signals the service already has. The handler doesn't call the ledger on every check. It looks at the success rate of real ledger writes over the last 10 seconds, kept in memory by the data access layer, and returns 503 if that rate falls below a threshold and there was enough traffic to judge. Add a manual override too: a flag in AWS AppConfig or Parameter Store that makes `/health/ready` return 503, so an operator in that Region can drain it without touching Global Accelerator's API.

One more trap: if every target in a target group is unhealthy, the ALB fails open and sends traffic to all of them anyway. That's sensible inside a Region. It doesn't affect Global Accelerator's view of the endpoint, but it's why you should alarm on `UnHealthyHostCount` and not just on 5xx.

### Capacity: the maths of static stability

In steady state each Region carries half the traffic: 3,000 requests per second. When one fails, the other gets all 6,000, immediately. If it's sized for 3,000 and plans to scale out, you have just made your RTO depend on Fargate launching hundreds of tasks during an event that may well be affecting capacity elsewhere.

The calculation for the example:

- One task handles about 60 requests per second at the target p99.
- Peak of 6,000 req/s with 20% headroom is 7,200 req/s, so 120 tasks.
- Each Region runs 120 tasks all the time, at about 42% utilisation in steady state.

That's the cost of active-active with two Regions: you pay for twice the peak. A third serving Region changes the maths. With three Regions, each needs to handle half the peak when one is lost, so you run 3 × 60 = 180 tasks instead of 240. You trade some compute for more operational surface and, for MRSC, a third full replica instead of a witness. For most teams two Regions plus a witness is the sweet spot.

Autoscaling still runs. It just isn't on the critical path. Target tracking on CPU and request count adds headroom over the next few minutes, so you're ready for the next spike while still in the failed-over state.

## Data: decide what "two Regions wrote at once" means

This is the hard part. Traffic routing is a solved problem; data isn't. The mistake I see most is choosing one database replication model for everything. A conflict on a language preference and a conflict on an account balance are not the same problem, and they shouldn't get the same solution.

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-region-active-active/active-active-data-conflicts.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-region-active-active/active-active-data-conflicts.svg" alt="Three kinds of data with three conflict rules, each shown as a small sequence diagram. First, money must never diverge: the ledger table is a DynamoDB global table with multi-Region strong consistency, with lifelines for us-east-1, a us-east-2 witness and us-west-2. With a balance of 100 dollars, a payment of 80 dollars in us-east-1 and a payment of 60 dollars in us-west-2 both arrive in the same millisecond, each as a conditional write on version 7. The quorum needs two of three. The east write commits, leaving a balance of 20 dollars at version 8; the west write gets a write conflict exception and retries, re-reads the balance of 20 dollars, which is less than 60, and the payment is declined. Result: no double spend and RPO zero; every write waits for a second Region to agree. Rules: exactly three Regions, three replicas or two plus a witness; every money movement is a conditional write on a version; idempotency keys live in this table; keep it small and hot; check the MRSC feature list. Second, user state converges and never blocks: the profiles table is an eventually consistent global table. A phone in us-east-1 puts item user 42 with notify off at 12:00:00.120, and a laptop in us-west-2 puts the same item with language hi at 12:00:00.310. After replication, both Regions keep the later item, with language hi and notify still on, so the notification change is lost, because the whole item wins rather than single attributes. Fix: one item per setting, with sort keys pref notify and pref language, so two writers touch two items and both survive. Rules: last writer wins is per item, so model small items one actor changes; route a user's writes to a home Region; use unique sort keys for append-only facts; conditional writes only check the local replica, so never use this table to stop duplicate payments; alarm on replication latency. Third, the relational back office has one writer: Aurora PostgreSQL Global Database. An app in us-west-2 runs an update, which is sent to the us-east-1 writer by write forwarding with one extra round trip, commits there, and comes back through storage replication with lag typically under a second. Result: no write conflicts by design, but writes from us-west-2 are slower and stop until failover if us-east-1 is lost. Rules: connect through the global writer endpoint; use switchover for planned moves and failover with allow data loss after a human decision for Region loss; watch the RPO lag metric and cap it with the rds.global_db_rpo parameter; keep Aurora off the payment path." width="1500" height="860" loading="lazy"></a><figcaption>Money gets a quorum, user state gets conflict-free modelling, and relational data keeps a single writer.</figcaption></figure>

### Money: DynamoDB global tables with multi-Region strong consistency

DynamoDB global tables support two consistency modes. The older one, multi-Region eventual consistency (MREC), replicates asynchronously and resolves conflicts with last writer wins. The newer one, [multi-Region strong consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html) (MRSC), commits a write only once it's durable in at least two Regions, so a strongly consistent read in any Region sees the latest committed value. It needs exactly three Regions: three full replicas, or two replicas and a witness. The witness stores what's needed to take part in the quorum but serves no reads or writes, which makes it much cheaper than a third replica.

For a ledger, this is what you want:

- **RPO 0.** A payment acknowledged to the customer is already in two Regions. Losing one Region loses nothing.
- **No double spend across Regions.** Every debit is a conditional write: "set balance to 20 and version to 8, if version is still 7". If two Regions try to change the same item at the same moment, one succeeds and the other gets a `ReplicatedWriteConflictException` (or fails the condition once the first write is visible). The loser retries, re-reads, and finds the balance has changed.
- **Survives a Region.** With us-east-1 gone, us-west-2 and the us-east-2 witness still form a quorum, so writes continue.

The costs are real. Every write waits for a second Region, so write latency includes a cross-Region round trip: low tens of milliseconds between us-east-1 and us-east-2, more from us-west-2. That's why the latency requirement for payments is 500 ms, not 100 ms. MRSC is only offered in certain Region sets, and it doesn't support every DynamoDB feature that MREC does (check the current list, transactions included, before you design around it). Keep the MRSC table focused: balances, holds and idempotency records. Payment history can flow out through DynamoDB Streams into a cheaper store.

Idempotency belongs in this table too. The client generates an `Idempotency-Key` for each payment and sends it on every retry. The API does a conditional put of `idem#<key>` alongside the debit. Because the table is strongly consistent across Regions, a retry that lands in the other Region after a failover still finds the first attempt and returns its result instead of charging twice. Put the same check in an MREC table and you've built a race: the condition is checked against the local replica only, and the first attempt may not have replicated yet.

### User state: eventual consistency, designed so it can't hurt

Profiles, preferences, device registrations and sessions don't need a quorum. They need to be writable in both Regions at all times and to converge quickly. An MREC global table does exactly that, with typical replication under a second. The catch is how conflicts resolve: **last writer wins, for the whole item**. If two Regions update the same item before replication catches up, the one with the later timestamp replaces the other entirely, including attributes the "winner" never meant to change.

The diagram shows the result. A phone in us-east-1 turns notifications off; a laptop that happens to be routed to us-west-2 changes the language 190 ms later. Both write `user#42`. After replication, both Regions hold the laptop's version, with notifications still on. Nobody gets an error, and the change is gone.

Design so that can't matter:

- **Model small items that one actor changes.** `pk = user#42, sk = pref#notify` and `sk = pref#language` are separate items, so the two writes no longer collide.
- **Prefer append-only for facts.** A new device or session is a new item with a unique sort key (a ULID works well). Inserts with unique keys never conflict.
- **Give users a home Region for writes.** The session token carries a `home_region` claim. While that Region is healthy, the API forwards the user's profile writes there; if it isn't, the local Region takes the write. This removes almost all concurrent writes without making the home Region a dependency.
- **Alarm on `ReplicationLatency`.** It is your actual RPO for this data. If it climbs from one second to forty, you want to know before a failover turns lag into loss.

### Relational back office: Aurora Global Database with one writer

KYC records, merchant contracts and settlement batches are relational, need transactions and joins, and are written by a few hundred staff rather than millions of customers. Aurora PostgreSQL Global Database fits: one writer in us-east-1, a read-only secondary cluster in us-west-2 kept current by storage-level replication with lag typically under a second.

This part of the system is deliberately not active-active for writes:

- Applications in us-west-2 read locally and send writes to the primary with [write forwarding](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-write-forwarding.html), paying one cross-Region round trip.
- Everything connects through the [global writer endpoint](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-connecting.html), which follows the writer when it moves, so there's no connection string to change during an event.
- A planned move (maintenance, a game day) is a **switchover**: Aurora waits for the secondary to catch up, so RPO is zero. Losing the primary Region is a **failover** with `--allow-data-loss`, and you lose whatever hadn't replicated. Aurora PostgreSQL lets you put a ceiling on that with the `rds.global_db_rpo` parameter, and the `AuroraGlobalDBRPOLag` metric tells you where you stand.

That's why Aurora sits outside the one-minute RTO. If us-east-1 goes, back-office writes are paused for a few minutes while someone confirms the event and runs the failover, but customers can still pay, because nothing on the payment path needs Aurora to accept a write. Read the [switchover and failover guide](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html) before you write your runbook; the details differ between planned and unplanned moves.

### Everything else

- **Caches are local.** ElastiCache in each Region warms from its own tables. A failover means a colder cache for a few minutes, so size the tables for that read rate.
- **Queues are local.** SQS isn't replicated. Messages in flight in a failed Region are delayed until it recovers, so consumers must be idempotent and producers must be able to replay.
- **Secrets and keys are replicated before you need them.** KMS multi-Region keys share key material and key ID across Regions, and Secrets Manager replica secrets keep the same name. Rotation runs in the primary and replicates.
- **Scheduled jobs run once.** A job scheduler in both Regions will run nightly settlement twice. Use a lease item in the MRSC table, or pin scheduled jobs to one Region and move them deliberately.

## A Region failure, second by second

Here's what this design does when us-east-1 has a serious problem at peak. The timings use the settings from this article.

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-region-active-active/active-active-failover-timeline.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-region-active-active/active-active-failover-timeline.svg" alt="Timeline of losing us-east-1 at peak, from t equals 0 to 60 seconds, then 2, 5 and 15 minutes, with lanes for the wallet app, Global Accelerator, the us-east-1 ALB and ECS, the us-west-2 ALB and ECS, data and people. A bracket marks the RTO for pay and balance at about 15 to 30 seconds. At t equals 0 a regional dependency fails in us-east-1 and the readiness endpoint starts returning 503; in-flight requests to us-east-1 fail and the app retries with the same idempotency key. The ALB health check, at a 5 second interval with an unhealthy threshold of 2, records the first failed check at 5 seconds and marks targets unhealthy at 10 seconds. From about 11 seconds Global Accelerator reports the endpoint unhealthy and sends new flows to us-west-2 within seconds. From about 16 seconds retries open new flows that land in us-west-2, which takes 100 percent of traffic without launching anything because it is pre-scaled. By about 36 seconds the error rate is back under 0.1 percent with no duplicate payments. In the data lane, for the whole period the ledger keeps writing on the us-west-2 plus witness quorum with RPO zero; profiles stay writable in us-west-2 and the last second or so of east-only writes replicate when east comes back; Aurora back-office writes are paused because the writer was in us-east-1, with reads still served by the local secondary. At about 44 seconds a burn-rate alarm and the endpoint-unhealthy alarm page the on-call. At 2 minutes the incident lead approves an Aurora failover and target tracking adds headroom in us-west-2; a planned evacuation would set the us-east-1 traffic dial to 0 percent. At 5 minutes the Aurora global failover puts the writer in us-west-2, and by 15 minutes all features are back and the team writes the timeline." width="1500" height="800" loading="lazy"></a><figcaption>Customer-facing recovery happens in the first half-minute without a human. People get involved for the parts that should need judgement.</figcaption></figure>

- **0 to 10 seconds.** Requests in flight to us-east-1 fail. The app retries with exponential backoff and jitter (200 ms base, three attempts), always with the same idempotency key. Some retries still land in us-east-1, because existing connections stick to the endpoint they opened against.
- **10 to 15 seconds.** The second failed health check marks the targets unhealthy. Global Accelerator stops sending new flows to us-east-1.
- **15 to 30 seconds.** Retries open new connections that go to us-west-2. It's already running 120 tasks, so it absorbs 6,000 req/s without launching anything. The ledger keeps committing through the us-west-2 and us-east-2 quorum.
- **30 to 60 seconds.** Error rate drops back under 0.1%. Duplicate payments: zero, because every retry carried its idempotency key into a strongly consistent table. The on-call gets paged by an SLO burn-rate alarm, not by the failover itself.
- **2 to 15 minutes.** A person confirms the event, approves the Aurora failover, and back-office writes resume in us-west-2. When us-east-1 recovers, it rejoins as a secondary; you fail back in a quiet hour with a switchover, not in the middle of the incident.

Two details in that timeline are easy to miss. First, the client's retry policy is part of your RTO; an app that gives up after one retry, or retries without the idempotency key, turns a 20-second shift into failed payments or double charges. Second, nothing in the first minute needed a control-plane call, a DNS change or a human.

## Testing failover: prove the number

Every team that runs active-active has had the same experience: the first real failover finds something the design didn't. Better that it's a game day.

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-region-active-active/active-active-failover-testing.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-region-active-active/active-active-failover-testing.svg" alt="Failover testing loop. Across the top, five steps in a loop: 1, a hypothesis written before the test; 2, an AWS FIS experiment template kept in Git; 3, observe from outside with canaries in three Regions; 4, a stop condition alarm that halts the test; 5, fix the plan by updating the runbook and the Region switch plan, then loop back next month with a harder test. An example hypothesis for experiment E1 reads: if us-east-1 app subnets lose connectivity at 50 percent traffic, Global Accelerator moves new flows to us-west-2 within 30 seconds, payment success stays at or above 99.5 percent over 5 minutes, and no payment is applied twice. A table lists five experiments. E1, app tier lost in one Region: inject with aws:network:disrupt-connectivity on the us-east-1 app subnets; pass if GA shifts in under 30 seconds and payment success is at least 99.5 percent; monthly; staging first, then production at 10 percent. E2, Regions cut off from each other: inject with the Cross-Region Connectivity scenario from the FIS library; pass if the isolated Region fails its health check and GA drains it; quarterly; staging only until three passes, then production. E3, profile replication paused: inject with aws:dynamodb:global-table-pause-replication on the profiles table; pass if the lag alarm fires within 2 minutes and the app keeps serving with no 5xx; monthly; production, profiles table only. E4, planned Region evacuation: set the GA traffic dial for us-east-1 to 0 percent and back to 100; pass with zero failed payments and a drain under 60 seconds; every release week; production in a low-traffic hour. E5, Aurora writer move: run the Region switch plan for an Aurora switchover to us-west-2; pass with RPO zero and back-office writes paused under 2 minutes; quarterly; production, Sunday 04:00 local. Stop conditions, any one of which halts the experiment: payment success in the surviving Region below 97 percent for 2 minutes, ledger write p99 above 400 milliseconds for 3 minutes, canary failure from 2 of 3 canary Regions at once, or a human pressing stop. A passing run leaves behind measured detection and shift times next to the target, the FIS experiment report and dashboard snapshot, an updated runbook and Region switch plan, and a ticket for each manual step that could be automated." width="1500" height="820" loading="lazy"></a><figcaption>Five experiments, each with a written pass condition, a cadence and a blast radius. Stop conditions keep a test from becoming an incident.</figcaption></figure>

The tools:

- **[AWS Fault Injection Service](https://docs.aws.amazon.com/fis/latest/userguide/what-is.html)** runs the experiments. The ones that matter most for this design are network disruption on the app subnets of one Region, the [Cross-Region: Connectivity scenario](https://docs.aws.amazon.com/fis/latest/userguide/cross-region-scenario.html), and pausing replication on an MREC global table. All are in the [FIS actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html). Keep experiment templates in Git with the rest of your infrastructure code.
- **Stop conditions** are CloudWatch alarms attached to the experiment. If payment success in the surviving Region drops below 97% for two minutes, FIS stops and rolls back its actions. Write these before the hypothesis, not after the first scare.
- **CloudWatch Synthetics canaries** run from three Regions, including one that isn't either of yours, and do what customers do: log in with a test account, read a balance, make a $0.01 payment to a test merchant. Measure success from the outside, because the inside view of a broken Region is often wrong.
- **[ARC Region switch](https://docs.aws.amazon.com/r53recovery/latest/dg/region-switch-plans.html)** holds the plan for the steps that aren't automatic: scaling, the Aurora switchover or failover, manual approvals. It's designed to run from the Region you're moving to, so it doesn't depend on the one that's failing. Practise the plan in game days so the first execution isn't during an incident.

Experiment E2 is the one that teaches people the most. When the Regions are cut off from each other but each still reaches the internet, us-east-1 can't reach the ledger quorum (it can see neither us-west-2 nor the witness), so ledger writes there fail. If the health check only looks at process liveness, Global Accelerator keeps sending customers to a Region where every payment fails. With the health check described above, the failing ledger writes push `/health/ready` to 503 and the Region drains itself. Run E2 in staging until it passes three times in a row.

Keep a record of each run with the measured numbers next to the targets. After six months you'll have real data on detection time, shift time and error budget spent, which is far more convincing to an auditor or a leadership review than a diagram.

## Production scenarios

The numbers below are illustrative, from the example workload, but each scenario is a pattern I'd plan for.

### 1. Gray failure: slow, not down

**What happens.** At 14:05 the p99 of payments in us-east-1 climbs from 180 ms to 2.4 s. Error rate stays at 0.3%, health checks pass, and Global Accelerator keeps sending half the traffic there. Customer complaints arrive before alerts do.

**Why.** Health checks answer "is it up?" and the honest answer is yes. Nothing in the design treats "slow" as "unhealthy".

**Fix.** Add a latency signal to readiness: if the in-process p99 for ledger writes stays above 1 second for 30 seconds with enough samples, `/health/ready` returns 503. Separately, a CloudWatch alarm on canary latency per Region pages the on-call with a one-line runbook: set the us-east-1 traffic dial to 0%. Draining took 40 seconds, and the dial went back to 100% in steps of 25% once the p99 recovered.

### 2. The double charge that didn't happen

**What happens.** During a failover, a customer's app sends a $250 transfer to us-east-1, the connection drops before a response arrives, and the app retries 1.2 seconds later. The retry lands in us-west-2.

**Why it's dangerous.** The first attempt may have committed. Without a shared, strongly consistent idempotency record, us-west-2 has no way to know.

**What the design does.** The first attempt wrote `idem#<key>` and the debit in the MRSC ledger, so the write is already in two Regions. The retry's conditional put of the same key fails, the API reads the stored result and returns "completed" with the original transaction ID. The customer sees one transfer. If you had put idempotency keys in an MREC table, there was a real chance (any replication lag over 1.2 seconds) that the retry would have been applied as a second transfer.

### 3. Replication lag spike on profiles

**What happens.** A bulk job backfills a new attribute into 8 million profile items in us-east-1 at 3,000 writes per second. `ReplicationLatency` to us-west-2 climbs from 0.8 s to 47 s. Users routed to us-west-2 see an old display name after changing it.

**Why.** Replication is fast, not free. A sustained burst of writes in one Region builds a backlog in the other.

**Fix.** Rate-limit backfills to a fraction of the table's normal write rate and run them in both Regions against their own items, or schedule them off-peak. Alarm when `ReplicationLatency` is above 5 seconds for 5 minutes, because that number is your RPO for this table. Point reads that must be read-your-writes (the profile screen right after an edit) at the user's home Region.

### 4. The scheduled job that ran twice

**What happens.** The nightly merchant settlement job was deployed to both Regions by the same pipeline. At 02:00 both ran. Each produced a settlement file; the bank received two.

**Why.** Active-active means every component runs everywhere unless you decide otherwise. Cron is a component.

**Fix.** Singleton jobs take a lease first: a conditional put of `lease#settlement#2026-11-20` in the MRSC table with the Region and an expiry. The loser exits. Because the table is strongly consistent across Regions, exactly one Region gets the lease, and if that Region dies mid-run, the lease expires and the other picks it up. The settlement process itself is idempotent per merchant per day, so a takeover can't double-pay.

### 5. A failover that worked, and a failback that didn't

**What happens.** A game day evacuates us-east-1 with the traffic dial and switches the Aurora writer to us-west-2. Everything passes. Three hours later the team sets the dial back to 100% and p99 in us-east-1 jumps to 1.8 s for eight minutes.

**Why.** While us-east-1 was idle, its ECS services scaled in to their minimum, and its ElastiCache cluster had nothing in it. Failback sent half the peak traffic to a Region with a cold cache and a third of its tasks.

**Fix.** Set the ECS minimum task count to the static-stability number (120), not to what idle traffic needs. Fail back in steps (25%, 50%, 100% over 15 minutes) and watch the cache hit ratio before each step. Add failback to the game day's pass conditions; it's half of every failover.

## Mapping to the AWS Well-Architected Framework

| Pillar | What this design does | Where to read more |
|---|---|---|
| **Reliability** | Regions as fault isolation boundaries; static stability (each Region pre-sized for 100% of peak); data-plane-only automatic failover; quorum writes for the ledger; recovery objectives defined per data class; failover tested monthly with FIS | [Reliability pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html) |
| **Operational excellence** | Same task definitions and pipeline in both Regions; Region switch plans for the manual steps; game days with written hypotheses; post-run records with measured RTO | [Operational excellence pillar](https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html) |
| **Security** | Internal ALBs with no public IP; KMS multi-Region keys and replica secrets so encryption works the same in both Regions; identical IAM roles deployed from code; audit trail per Region | [Security pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) |
| **Performance efficiency** | Anycast entry close to users; reads served in-Region; the expensive consistency (MRSC) used only where it is required | [Performance efficiency pillar](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html) |
| **Cost optimization** | A witness instead of a third replica; caches and queues not replicated; Aurora not duplicated as a second writer; Graviton-based Fargate tasks; Savings Plans on the steady baseline | [Cost optimization pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html) |
| **Sustainability** | Idle capacity is the price of a sub-minute RTO, so it is bought only for the paths that need it; batch and analytics stay single-Region | [Sustainability pillar](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html) |

## What it costs, roughly

Compared with the same workload in one Region:

- **Compute** roughly doubles, because each Region is sized for the full peak. This is the biggest line, and the main reason to be honest about which services truly need a one-minute RTO.
- **DynamoDB** charges for writes in every replica Region, so a two-replica global table pays for writes twice, and MRSC adds the witness. Cross-Region replication traffic is billed as data transfer.
- **Aurora** adds a secondary cluster (instances plus storage) and replicated write I/O.
- **Global Accelerator** has a fixed hourly fee per accelerator plus a data transfer premium per GB, which is small next to compute for an API like this.
- **Testing** costs a little: FIS bills per action-minute, and canaries per run.

For the example, the total landed at about 2.1× the single-Region cost, inside the 2.3× ceiling in the requirements. Check the current pricing pages for your Regions; the ratios matter more than the exact figures.

## Checklist

- [ ] RTO and RPO written per data class, not one number for the whole system
- [ ] Global Accelerator in front of internal ALBs; Route 53 alias pointing at it
- [ ] Each serving Region sized for 100% of peak plus headroom; ECS minimums set to match
- [ ] Readiness checks that reflect real Regional dependency health, plus a manual drain flag
- [ ] Ledger and idempotency keys in an MRSC global table; every debit a conditional write
- [ ] MREC tables modelled as small items, with home-Region writes and replication-lag alarms
- [ ] Aurora behind the global writer endpoint, off the payment path; switchover and failover runbooks rehearsed
- [ ] KMS multi-Region keys, replica secrets and ECR replication in place before day one
- [ ] Singleton jobs protected by a strongly consistent lease
- [ ] Clients retry with backoff, jitter and the same idempotency key
- [ ] Monthly FIS game day with stop conditions; failback included; results recorded

## Diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the Regions, services and numbers to match your system.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-multi-region-active-active/aws-multi-region-active-active.drawio)
- [Active-active reference architecture](/assets/diagrams/aws-multi-region-active-active/active-active-reference.drawio)
- [Region failure timeline](/assets/diagrams/aws-multi-region-active-active/active-active-failover-timeline.drawio)
- [Data classes and conflict handling](/assets/diagrams/aws-multi-region-active-active/active-active-data-conflicts.drawio)
- [Failover testing loop](/assets/diagrams/aws-multi-region-active-active/active-active-failover-testing.drawio)

## References

- [Disaster recovery of workloads on AWS (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html)
- [AWS Fault Isolation Boundaries (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/abstract-and-introduction.html)
- [Static stability](https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/static-stability.html)
- [How AWS Global Accelerator works](https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html)
- [Global Accelerator health check options](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoint-groups-health-check-options.html)
- [Health checks for Application Load Balancer target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
- [How DynamoDB global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html)
- [Best practices for DynamoDB global tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-global-table-design.html)
- [Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- [Aurora Global Database switchover and failover](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)
- [Connecting to Aurora Global Database (global writer endpoint)](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-connecting.html)
- [ARC Region switch](https://docs.aws.amazon.com/r53recovery/latest/dg/region-switch-plans.html)
- [AWS Fault Injection Service actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [FIS Cross-Region: Connectivity scenario](https://docs.aws.amazon.com/fis/latest/userguide/cross-region-scenario.html)
- [AWS Well-Architected Framework, Reliability pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
