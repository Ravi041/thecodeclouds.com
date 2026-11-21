---
title: "Real-time streaming analytics on AWS with Kinesis: shards, Flink, late data and a lake you can trust"
description: "A production design for real-time analytics on AWS: Kinesis Data Streams sized from real numbers, Managed Service for Apache Flink with event-time windows, OpenSearch for live dashboards, Amazon Data Firehose into an Iceberg data lake, and how to deal with hot shards, late events, duplicates and consumer lag. Mapped to the AWS Well-Architected pillars, with three editable draw.io diagrams."
date: 2026-11-21T03:04:00Z
category: Cloud & DevOps
coverLabel: "Streaming\nanalytics on AWS,\nminus the hot shards."
coverCode: "54 MB/s peak · 72 shards · p95 < 10 s"
coverLogos: "aws"
coverImage: /assets/images/covers/kinesis-real-time-streaming-analytics.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Streaming analytics on AWS, minus the hot shards.', with the AWS logo."
---
Every streaming project starts the same way. Someone draws producers on the left, a stream in the middle and a dashboard on the right, and it works in the demo. Then the first big promotion sends half the traffic through one partition key, a courier drives into a tunnel and their events arrive four minutes late, a producer retries and the order count on the ops screen is 3% higher than the payments ledger. None of that is in the box-and-arrow drawing, and all of it decides whether people trust the numbers.

This article is the design I'd use for real-time analytics on AWS today, built around one example: a food-delivery marketplace running in 30 cities. It covers how to size Kinesis Data Streams from actual traffic, where Managed Service for Apache Flink earns its place, how event time and watermarks handle late data, and how Amazon Data Firehose lands everything in an Apache Iceberg lake that stays the system of record. After the design there are five incidents, each with the numbers that showed the problem and the change that fixed it.

There are three diagrams, each an editable `.drawio` file using the AWS shapes that ship with draw.io.

## The short version

- **Write the requirements as numbers first.** Events per second at peak, average record size, end-to-end latency target, how late data can arrive and how long you need to replay. The design falls out of those five numbers.
- **Size shards for the peak, and pick partition keys for spread, not for meaning.** A shard takes 1 MB/s or 1,000 records/s. One partition key can never go faster than one shard, whatever the shard count.
- **Use Flink for anything that needs state or time.** Windows, joins, deduplication and late data are what Managed Service for Apache Flink is for. Lambda is great for per-record reactions, not for "orders per zone per minute".
- **Use event time, a bounded watermark and allowed lateness.** Dashboards get a fast first answer and correct themselves. Data later than that goes to a side output and is fixed in batch, never dropped.
- **Make every sink idempotent.** Kinesis and Firehose are at-least-once. Deterministic document IDs in OpenSearch and `MERGE` on an event ID in Iceberg turn retries into no-ops.
- **The lake is the source of truth, the dashboard is a fast estimate.** Firehose delivers raw events to Iceberg tables in S3. Nightly jobs reconcile, and finance reads from the lake.
- **Alarm on lag, not on CPU.** `GetRecords.IteratorAgeMilliseconds`, `millisBehindLatest` and `WriteProvisionedThroughputExceeded` tell you a pipeline is in trouble long before a dashboard goes stale.

## The scenario and its requirements

The example business is a food-delivery marketplace: a customer app, a courier app and a restaurant tablet app, running in 30 cities split into about 1,200 delivery zones. Today, analytics is a nightly batch job, so operations staff find out about a zone with no couriers the next morning. They want to see it within seconds and react while it matters.

### Functional requirements

| # | Requirement | Who uses it |
|---|---|---|
| F1 | Live ops dashboard: orders, active couriers, average delivery time and cancellations per zone per minute | City operations teams |
| F2 | Zone pressure signal (open orders ÷ available couriers) updated every 10 seconds, read by the surge-pricing service | Pricing service |
| F3 | Alerts when a zone has no free courier for 3 minutes, or when payment failures in a city pass 5% over 2 minutes | On-call ops, Slack |
| F4 | Every raw event stored, queryable with SQL, and replayable to rebuild any metric | Analysts, data science, finance |
| F5 | Daily business reporting that matches the payments ledger | Finance, leadership |

### Non-functional requirements

| Requirement | Target | Why this number |
|---|---|---|
| Peak ingest | 54,000 events/s, about 66 MB/s across all streams | Today's measured Friday 19:00–21:00 peak of 45,000 events/s, plus 20% growth |
| Average ingest | 18,000 events/s, about 22 MB/s | Peak is roughly 3× the daily average |
| End-to-end latency (event to dashboard) | p95 under 10 s | Ops react in minutes, but a 1-minute delay makes the screen feel broken |
| Late data | Up to 2 min corrected live, anything later corrected by next morning | Couriers lose signal in tunnels and car parks; the app buffers and flushes |
| Order events | No loss once accepted; duplicates allowed but must not be counted twice | Orders feed finance numbers |
| Replay window | 7 days in the stream, unlimited from the lake | Rebuild a metric after a bug fix without re-ingesting from devices |
| Availability | 99.9% for ingest; dashboards may degrade, ingest may not | Losing data is worse than a stale screen |
| Data protection | Customer and courier IDs pseudonymised before they reach dashboards; everything encrypted with customer managed KMS keys | GDPR, and least access for ops staff |
| Region | eu-west-1, data stays in the EU | Data residency for EU customers |

Today's measured peak, by source:

| Source | Peak events/s today | Avg size | Peak MB/s today | Notes |
|---|---|---|---|---|
| Customer app events (views, search, cart) | 31,000 | 1.45 KB | 45 | Spiky, follows promotions |
| Courier GPS pings | 12,000 (48,000 couriers, every 4 s) | 0.4 KB | 4.8 | Steady while couriers are online; arrives late after signal loss |
| Order lifecycle events | 2,000 | 2.5 KB | 5 | Low volume, high value, needs per-order ordering |

## The architecture

<figure class="diagram wide"><a href="/assets/diagrams/kinesis-streaming-analytics/kinesis-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/kinesis-streaming-analytics/kinesis-reference.svg" alt="Reference architecture in eu-west-1. The customer app and courier app send events through API Gateway, a REST API with Cognito authorisation and a PutRecords integration (step 1). The order service on EKS writes with the Kinesis Producer Library. Kinesis Data Streams, encrypted with KMS (step 2), has three streams: app-events in provisioned mode with 72 shards and partition key session_id, courier-locations in on-demand mode keyed by courier_id, and orders in provisioned mode with 8 shards keyed by order_id, all with 7-day retention. A Managed Service for Apache Flink application called live-metrics (step 3) reads all three as an enhanced fan-out consumer, using event time with a 30-second watermark. It writes 1-minute per-zone metrics to OpenSearch Service with document id zone plus window (step 4), viewed in OpenSearch Dashboards; writes a zone-pressure table in DynamoDB read by the surge pricing service (step 5); and writes to an alerts stream (step 6) consumed by Lambda, with bisect on error and an SQS failure destination, which notifies SNS for on-call and Slack. Amazon Data Firehose (step 7) reads app-events and orders as shared-throughput consumers and delivers to Apache Iceberg tables in an S3 data lake with raw, curated and late prefixes (step 8). Flink also sends events later than 2 minutes to the late prefix as a side output. The Glue Data Catalog holds schemas, Athena runs ad hoc SQL and the nightly reconciliation, and QuickSight shows the daily business view. CloudWatch alarms on iterator age, throughput exceeded and millisBehindLatest, and KMS customer managed keys encrypt the streams, Firehose, S3 and OpenSearch." width="1500" height="960" loading="lazy"></a><figcaption>The reference design: three streams, one Flink job for everything stateful, a hot path to OpenSearch and DynamoDB, and a lake path through Firehose to Iceberg. Numbers match the steps below.</figcaption></figure>

1. **Ingest through API Gateway.** The mobile apps batch events for up to 5 seconds or 50 events and send them to a REST API that integrates directly with Kinesis `PutRecords`, with no Lambda in the middle. Cognito authorises the app, and API Gateway throttling and usage plans protect the stream from a buggy app release that sends in a loop. The order service is a backend producer, so it writes directly with the Kinesis Producer Library (KPL) and its aggregation turned on.
2. **Three streams, split by behaviour, not by team.** Clickstream, GPS and orders differ in volume, ordering needs and value, so they get separate streams with separate keys, capacity modes and alarms. More on sizing below.
3. **One Flink application does all the stateful work.** It reads with enhanced fan-out, so it gets its own 2 MB/s per shard and isn't competing with Firehose for read throughput. It keys by zone, runs 1-minute tumbling windows in event time, deduplicates by event ID, and computes the zone pressure ratio.
4. **OpenSearch for the live dashboard.** Each window result is upserted with document ID `zone|window_start`. A late correction overwrites the earlier value instead of adding a second document. Indices roll over daily and an Index State Management policy deletes them after 14 days, because the lake keeps history.
5. **DynamoDB for the pricing service.** The surge-pricing service needs a single-digit-millisecond lookup by zone, not a search query. Flink writes one item per zone every 10 seconds.
6. **Alerts as a stream.** Flink writes alert events to a small stream, and a Lambda function formats them and sends them to SNS. This keeps Flink free of HTTP calls to Slack and gives you a replayable record of every alert fired.
7. **Firehose into Iceberg.** Firehose reads `app-events` and `orders` and writes them to Apache Iceberg tables in S3, buffering up to 128 MiB or 300 seconds. Firehose uses the shared 2 MB/s per-shard read limit, which is fine for one consumer next to an EFO consumer.
8. **The lake answers the hard questions.** The Glue Data Catalog holds the table definitions, Athena runs ad hoc queries and the nightly reconciliation, and QuickSight reads curated daily tables. When the live number and the lake disagree, the lake wins and the job that computed the live number gets a bug ticket.

### Why these services, and what I didn't pick

| Decision | Chosen | Considered | Why |
|---|---|---|---|
| Stream | Kinesis Data Streams | Amazon MSK (Kafka) | No Kafka expertise on the team, fully managed scaling and IAM-native auth. MSK makes sense if you already run Kafka, need very long retention with tiered storage or want the Kafka connector ecosystem. |
| Stream processing | Managed Service for Apache Flink | Lambda, KCL application on ECS | Windows, keyed state, event time and checkpoints are built in. Rebuilding those in Lambda means DynamoDB state tables and a lot of edge cases. |
| Live store | OpenSearch Service | Timestream, CloudWatch metrics | Dashboards with filters, drill-down and ad hoc aggregations across 1,200 zones. Ops staff already use OpenSearch Dashboards. |
| Lake delivery | Amazon Data Firehose | Flink `FileSink`, Kinesis connector to Glue | No code, retries and error output built in, and it writes Iceberg tables directly. Flink only writes the late-data side output. |
| Lake format | Apache Iceberg in S3 | Plain Parquet partitions | `MERGE` for deduplication and late corrections, schema evolution and time travel, without rewriting whole partitions. |

## Sizing the streams from the numbers

A shard in provisioned mode gives you, per the Kinesis quotas page:

- **Write:** 1 MB/s or 1,000 records/s, whichever you hit first.
- **Read (shared):** 2 MB/s across all standard consumers, and 5 `GetRecords` calls per second.
- **Read (enhanced fan-out):** 2 MB/s per registered consumer, pushed over HTTP/2 with `SubscribeToShard`.

| Stream | Mode | Write-bound shards | Record-bound shards | Chosen | Why |
|---|---|---|---|---|---|
| app-events | Provisioned | 45 MB/s today, 54 MB/s with growth: 54 shards | 37,200 records/s with growth: 38 shards (about 3 with batching) | **72** | Peak lands at 75% of write capacity, leaving room for a promotion before resharding |
| courier-locations | On-demand | 5.8 MB/s with growth: 6 shards | 14,400 records/s with growth, so the record limit dominates: 15 shards | **On-demand** | Volume follows how many couriers are online, which changes hour by hour. On-demand handles that without a scaling job |
| orders | Provisioned | 6 MB/s with growth: 6 shards | 2,400 records/s with growth: 3 shards | **8** | Small and steady. 8 shards keep the design peak at 75% and give per-order ordering by `order_id` |

Two notes on those numbers. First, the bare minimum for `app-events` is 54 shards, and 72 keeps the design peak at 0.75 MB/s per shard, so a promotion that beats the forecast doesn't throttle before you can reshard. Second, the records-per-second limit is the one that catches GPS and IoT-style traffic: 14,400 tiny pings a second need 15 shards even though they're under 6 MB/s.

**Provisioned or on-demand?** On-demand is the right default when you don't know your traffic, or it moves around a lot. It scales to around double the previous 30-day peak without you doing anything, but a jump beyond that can still throttle while it adapts, and you pay per GB in and out. Provisioned is cheaper for a steady, well-understood stream, but you own the scaling. `UpdateShardCount` can at most double or halve the shard count per call and has a daily call quota, and resharding takes minutes, so you scale *before* the Friday promotion, not during it. Here, the clickstream and orders are predictable enough for provisioned, and GPS isn't.

**Retention.** 24 hours is the default. I set 7 days on all three streams, because the most common real-world replay is "we shipped a bug in the Flink job on Thursday and noticed on Monday". Longer retention costs extra per shard-hour, and anything older comes from the lake.

**Aggregation is a cost lever, not just a throughput one.** Provisioned streams bill PUT payload units of 25 KB. A 1.45 KB event sent alone costs a whole unit. Batching 15–18 events into one ~24 KB record cuts the PUT units for `app-events` by more than 90%. The KPL does this for backend producers, and the mobile apps pack each batch from one session into a single record before calling the API. Consumers de-aggregate with the KCL or the Flink connector.

## Hot shards: the partition key decides more than the shard count

<figure class="diagram wide"><a href="/assets/diagrams/kinesis-streaming-analytics/kinesis-hot-shards.svg" title="Open the full-size diagram"><img src="/assets/diagrams/kinesis-streaming-analytics/kinesis-hot-shards.svg" alt="Two panels comparing partition keys on the same 72-shard stream. Left, before: partition key is zone_id with 1,200 delivery zones. PutRecords hashes the key with MD5 to a 128-bit hash key range, which maps to exactly one shard. During a Friday 19:00 free-delivery promotion one zone alone offers 1.6 MB/s, so shard 17 runs at 160% of its 1 MB/s or 1,000 records/s write limit while the other shards shown sit between 70 and 76%. Shard 17 accepts 1 MB/s and rejects the rest with WriteProvisionedThroughputExceeded, PutRecords FailedRecordCount rises and producer retries add load, while the stream-level average still reads about 76%. Resharding does not help because a single partition key always maps to a single shard. Right, after: partition key is session_id with about 400,000 live sessions. The same 54 MB/s peak spreads evenly at 73 to 77% per shard, 0.75 MB/s each, with no throttling; Flink keyBy zone_id regroups events after the read so per-zone windows are unchanged, and per-session ordering is kept. Four tips underneath: if you need per-key order, add a bounded suffix such as zone_id plus hash of session_id modulo 8 and merge the sub-streams in Flink; find the hot shard with shard-level enhanced monitoring metrics; KPL aggregation fixes the records-per-second limit but not the 1 MB/s one, and retry with jitter; and give Flink enhanced fan-out so Firehose and Lambda don't starve it of the shared 2 MB/s read limit." width="1500" height="745" loading="lazy"></a><figcaption>One promotion, one partition key, one throttled shard. A high-cardinality key spreads the same load, and Flink regroups by zone after the read.</figcaption></figure>

Kinesis hashes every partition key with MD5 into a 128-bit number, and each shard owns a slice of that range. That has two consequences people learn the hard way:

1. **One key, one shard, forever.** If one key produces 1.6 MB/s, it will be throttled at 1 MB/s whether the stream has 8 shards or 800. Resharding moves *ranges*, it never splits a key.
2. **The stream-level metrics hide it.** `IncomingBytes` for the stream averages across shards. The only way to see a hot shard is shard-level ("enhanced") metrics, which you turn on with `EnableEnhancedMonitoring` and which cost extra per shard, so it's common to enable them only during an incident. I keep them on for the busiest stream, because by the time you turn them on, the promotion is over.

The tempting key is the one that matches the business question: "we aggregate by zone, so key by zone". Don't. The stream key only needs to **spread load and keep the ordering you actually need**. For clickstream, ordering inside a session matters (a "checkout" event after its "add to cart") and ordering across sessions doesn't, so `session_id` is the right key. Flink's `keyBy(zone_id)` then regroups the events after reading, which is a network shuffle inside the Flink cluster and costs nothing in Kinesis terms.

If you genuinely need per-key ordering for a key that can get hot, add a bounded suffix: `zone_id#(hash(session_id) % 8)` spreads one zone over up to 8 shards, keeps order within each sub-key, and Flink merges the 8 sub-streams. Use `ExplicitHashKey` only when you deliberately want to pin traffic to a shard, for example to isolate a known noisy tenant.

## Event time, watermarks and late data

<figure class="diagram wide"><a href="/assets/diagrams/kinesis-streaming-analytics/kinesis-late-data.svg" title="Open the full-size diagram"><img src="/assets/diagrams/kinesis-streaming-analytics/kinesis-late-data.svg" alt="Timeline in event time from 12:00:00 to 12:04:00 with 1-minute tumbling windows; window W covers 12:00 to 12:01. Point A: the watermark reaches 12:01:00 when the newest event seen is 12:01:30, because the watermark is the newest event time minus 30 seconds, and W fires its first result. Point B: the watermark reaches 12:03:00, the 2-minute allowed lateness is over and W's state is purged. Event e1 with event time 12:00:20 arrives before A and is counted in the first result. Event e2 with event time 12:00:45 arrives between A and B, because the courier was in a tunnel and the app flushed late, so W re-fires with a corrected count. Event e3 with event time 12:00:50 arrives after B, because the phone was off for 4 minutes, and goes to the late-data side output. withIdleness of 1 minute stops a quiet shard from holding the watermark back. Below, the flow: courier-locations, app-events and orders streams feed a Flink source using enhanced fan-out with WatermarkStrategy forBoundedOutOfOrderness 30 seconds and withIdleness 1 minute, then keyBy zone_id, tumbling event-time windows of 1 minute, allowedLateness 2 minutes and sideOutputLateData. On-time results and corrections up to 2 minutes late are upserted to OpenSearch Service with document id zone plus window start. Events more than 2 minutes late go to an S3 late prefix, an Iceberg table partitioned by hour, and Athena runs a nightly MERGE at 02:00 into the hourly_zone_metrics table, so the lake stays the system of record. A note explains that dashboards get a number within about 35 seconds of the minute closing and correct it for 2 more minutes, deterministic ids make re-fires and restarts idempotent, and nothing is dropped; data later than 2 minutes is about 0.3% here, so it is fixed in batch instead of holding state for hours." width="1500" height="790" loading="lazy"></a><figcaption>A window fires once the watermark passes its end, re-fires for late events within the allowed lateness, and sends anything later to a side output that batch reconciles.</figcaption></figure>

If you window on arrival time ("processing time"), every courier who loses signal moves their deliveries into the wrong minute, and replaying a day of data gives a different answer from the live run. So the apps stamp `event_time` when the event happens (corrected with a server clock offset the app fetches at login), and the Flink job windows on that.

Event time needs a rule for "how long do I wait for stragglers". In Flink, that's three settings:

- **Watermark: `forBoundedOutOfOrderness(30 s)`.** The watermark is the newest event time seen minus 30 seconds. A window `[12:00, 12:01)` fires its first result when the watermark passes 12:01:00. We measured the delay distribution for a week before choosing 30 seconds: 99.2% of events arrive within 30 s of their event time.
- **`allowedLateness(2 min)`.** After the first result, the window keeps its state for 2 more minutes of event time. A late event re-fires the window with a corrected value, and the upsert by `zone|window_start` overwrites the earlier document in OpenSearch. Another 0.5% of events land here.
- **`sideOutputLateData`.** Anything later than that, about 0.3% here, goes to a side output written to a `late/` Iceberg table. A nightly Athena `MERGE` folds it into the hourly aggregates, so the lake numbers are complete by morning.

The trade-off is explicit: a bigger watermark delay means a slower first answer, a longer allowed lateness means more state in Flink. Holding state for 2 minutes across 1,200 zones is trivial. Holding it for an hour to catch the last 0.3% would multiply state size and checkpoint time for little benefit.

One setting that's easy to miss is **`withIdleness(1 min)`**. Flink takes the *minimum* watermark across all source partitions. If one shard receives nothing (a quiet city at 04:00, or a new shard after scaling), its watermark doesn't move, and no window anywhere fires. Marking a partition idle after a minute without data lets the rest of the job carry on.

## Exactly-once results from at-least-once delivery

Kinesis producers retry, Firehose retries, Lambda retries and Flink restarts from its last checkpoint. You'll get duplicates, so the design has to make them harmless rather than pretend they don't happen:

- **Every event carries a UUID `event_id`** generated on the device or service, not by the ingest API, so a retried HTTP call carries the same ID.
- **Flink deduplicates** with keyed state on `event_id` and a 15-minute state TTL, which covers producer retries without growing state forever.
- **Flink state is exactly-once** through checkpoints every 60 seconds. Sinks are where duplicates come back, so every sink is idempotent: OpenSearch and DynamoDB writes are upserts by a deterministic key, and the alert Lambda checks an idempotency key before notifying.
- **The lake is deduplicated on read and on compaction.** Firehose can deliver a record twice. The curated Iceberg tables are built with `MERGE INTO ... ON event_id`, and the raw table is kept as-is for audit.

## Mapping the design to the AWS Well-Architected Framework

| Pillar | What this design does | Where to look |
|---|---|---|
| **Operational excellence** | Everything in Terraform, Flink jobs deployed from CI with a snapshot taken before each update, runbooks for resharding and replay, alarms on lag rather than on CPU, game days that replay a Friday peak from the lake into a staging stream | CloudWatch, Flink snapshots, Iceberg time travel |
| **Security** | Server-side encryption with a customer managed KMS key on every stream, Firehose, S3 and OpenSearch; producers can only `PutRecords` to their own stream ARN; Flink and Firehose use their own IAM roles; Kinesis and Firehose reached over VPC interface endpoints; IDs pseudonymised in Flink before reaching OpenSearch; Lake Formation permissions on the curated tables | KMS, IAM, VPC endpoints, Lake Formation |
| **Reliability** | Kinesis stores data across three Availability Zones in the Region; 7-day retention means any consumer can rewind; Flink checkpoints and automatic restarts; Lambda with bisect on error, bounded retries and an SQS failure destination; Firehose error output to S3; the lake can rebuild any live metric | Kinesis retention, Flink checkpoints, DLQs |
| **Performance efficiency** | Shards sized for the measured peak at 75% utilisation; high-cardinality partition keys; enhanced fan-out for the latency-sensitive consumer; Flink autoscaling on CPU with a minimum parallelism of 24 so a scale-up isn't needed at 19:00 sharp | Shard metrics, Flink `millisBehindLatest` |
| **Cost optimisation** | Provisioned mode for steady streams and on-demand only where traffic is unpredictable; batching to cut PUT payload units; OpenSearch keeps 14 days, the lake keeps everything in cheaper storage; Flink scales down overnight; Firehose instead of a custom consumer fleet | Cost Explorer by tag, PUT payload units |
| **Sustainability** | No idle consumer fleets; aggregation cuts request volume; Parquet with compression in Iceberg means less data scanned per query; Graviton-based OpenSearch instances; S3 lifecycle moves old raw data to colder storage classes | S3 Storage Lens, Athena bytes scanned |

The Well-Architected Data Analytics Lens has a section on streaming that's worth reading alongside this table, especially its questions on data quality and on handling late and out-of-order data.

## Five incidents, and what fixed them

### 1. The free-delivery promotion that throttled one shard

**What happened.** Marketing ran a free-delivery promotion in one city centre district on a Friday at 19:00. Within four minutes, the app's event SDK showed rising retries, and the ops dashboard stopped updating for that district only. CloudWatch for the stream showed `IncomingBytes` at about 75% of capacity, which looked healthy.

**What the numbers said.** Shard-level metrics showed one shard at 1,000 KB/s accepted and `WriteProvisionedThroughputExceeded` climbing, while the other 71 sat around 70–76%. The partition key was `zone_id`, and the promoted zone alone was producing 1.6 MB/s. The client's retries without jitter then hit the same shard harder.

**What fixed it.** Short term: the SDK's retry was changed to exponential backoff with full jitter through a remote config flag, and the promotion's banner refresh interval was raised. Long term: the partition key moved to `session_id` and the Flink job kept `keyBy(zone_id)`. The same traffic now spreads to within ±3% across shards. See the hot-shard diagram above.

### 2. Flink fell nine minutes behind after a deploy

**What happened.** After a Tuesday afternoon deploy that added two new per-zone metrics, `millisBehindLatest` for the Flink job climbed from under 1 second to 9 minutes over 40 minutes. Dashboards were "live" but showing the past.

**What the numbers said.** Flink's backpressure view showed the OpenSearch sink at 100% busy. OpenSearch was rejecting bulk requests with HTTP 429 because the new metrics tripled the number of documents per window, and the index had 2 primary shards on 3 data nodes, so write load was concentrated on two nodes.

**What fixed it.** The sink was changed to emit one document per zone-window carrying all metrics as fields instead of one document per metric, cutting write volume by 70%. The daily index template went to 6 primary shards, and bulk requests were sized at about 5 MB. An alarm now fires when `millisBehindLatest` is above 60 seconds for 5 minutes, which would have caught this 35 minutes earlier.

### 3. The dashboard showed 3% more orders than finance

**What happened.** Every Monday, someone in finance asked why the live order count for the weekend was higher than the payments ledger. The gap was 2–4%, worse on busy evenings.

**What the numbers said.** Querying the raw Iceberg table for duplicate `event_id` values showed 3.1% of order events appearing twice, almost all within 2 seconds of each other. The order service's producer retried whole `PutRecords` batches when only some records in the batch failed, re-sending the ones that had succeeded.

**What fixed it.** Two changes. The producer now retries only the records with an error code in the `PutRecords` response, which is how the API is meant to be used. And the Flink job gained a dedupe step on `event_id` with a 15-minute TTL, so a duplicate from any cause can't be counted twice. The weekend gap is now under 0.05%, and the nightly reconciliation explains what remains.

### 4. No windows fired at 04:00

**What happened.** The overnight courier dashboard for two small cities stopped updating between about 03:30 and 05:00 every night, although couriers were working and events were arriving.

**What the numbers said.** The Flink job's watermark was stuck. After on-demand scaling had created extra shards for `courier-locations` the previous evening, some of those shards received no records at night. Each idle shard held its partition's watermark still, and because Flink uses the minimum across partitions, every window in the job was waiting.

**What fixed it.** `withIdleness(Duration.ofMinutes(1))` on the watermark strategy, and an alarm on the job's current watermark lagging wall-clock time by more than 3 minutes. If your windows ever stop firing while data is clearly arriving, look at the watermark before anything else.

### 5. One poison record blocked an alert shard for six hours

**What happened.** The alert Lambda stopped sending alerts for one city overnight. Nobody noticed until the morning, because the problem was the absence of alerts.

**What the numbers said.** `IteratorAge` for one shard of the alerts stream had grown to 6 hours. A malformed alert record (a zone name with an unescaped character that broke the Slack payload) made the function throw, and with the default settings Lambda retried the same batch until the record expired, blocking everything behind it on that shard.

**What fixed it.** The event source mapping now sets `BisectBatchOnFunctionError`, `MaximumRetryAttempts: 3`, `MaximumRecordAgeInSeconds: 600` and an SQS on-failure destination, and the function returns partial batch failures with `ReportBatchItemFailures`. A bad record now costs a few seconds and ends up in a queue someone looks at. The alarm on `IteratorAge` per function went from "never" to "above 60 seconds".

## Monitoring that tells you something useful

| Metric | Alarm when | What it means |
|---|---|---|
| `GetRecords.IteratorAgeMilliseconds` (stream, Firehose, Lambda) | > 60 s for 5 min | A consumer is falling behind; data is waiting in the stream |
| Flink `millisBehindLatest` | > 60 s for 5 min | The Flink job is behind the head of the stream |
| `WriteProvisionedThroughputExceeded` | > 0 for 3 of 5 min | Producers are being throttled; check shard-level metrics for a hot key |
| `PutRecords.FailedRecords` | > 0.5% of records | Partial batch failures; producers must retry only the failed records |
| Flink current watermark vs wall clock | > 3 min behind | An idle partition or a stuck source; windows aren't firing |
| Flink checkpoint duration and failures | duration > 30 s, or any failure | State is growing or a sink is slow; recovery will be slow too |
| Firehose delivery success for your destination | < 100% for 15 min | Lake delivery failing; records go to the error output |
| OpenSearch `ThreadpoolWriteRejected` | > 0 | Bulk writes rejected; the Flink sink will back up next |

Pair these with the business signal the whole pipeline exists for: an alarm when orders per minute for a city drops more than 50% below the same minute last week. That catches the failures none of the technical metrics see, such as an app release that stopped sending events at all.

## Production checklist

- Requirements written as numbers: peak events/s, record size, latency target, lateness, replay window.
- Shards sized for peak at 70–80% utilisation, with a high-cardinality partition key per stream.
- Shard-level metrics on for the busiest stream; alarms on throttling, iterator age and Flink lag.
- Retention set to cover your longest "we found a bug" gap, typically 7 days.
- Enhanced fan-out for the latency-sensitive consumer; shared reads for at most one or two others.
- Flink with event time, a measured watermark delay, allowed lateness, idleness and a late-data side output.
- Every event has an ID, and every sink is idempotent.
- Lambda consumers with bisect, bounded retries, a max record age and an on-failure destination.
- Customer managed KMS keys, least-privilege IAM per producer and consumer, VPC endpoints.
- A tested replay runbook: rewind a consumer to a timestamp, and rebuild a metric from the lake.

## Download the diagrams

- [All three diagrams in one file (3 pages)](/assets/diagrams/kinesis-streaming-analytics/kinesis-streaming-analytics.drawio)
- [Reference architecture](/assets/diagrams/kinesis-streaming-analytics/kinesis-reference.drawio)
- [Hot shards and partition keys](/assets/diagrams/kinesis-streaming-analytics/kinesis-hot-shards.drawio)
- [Event time, watermarks and late data](/assets/diagrams/kinesis-streaming-analytics/kinesis-late-data.drawio)

Traffic figures, shard counts and thresholds are from the example design. Check current Kinesis quotas, prices and regional availability for your own Region before you build, as AWS adjusts them over time.

## References

- [Amazon Kinesis Data Streams quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html)
- [Choosing the data stream capacity mode](https://docs.aws.amazon.com/streams/latest/dev/how-do-i-size-a-stream.html)
- [Developing enhanced fan-out consumers](https://docs.aws.amazon.com/streams/latest/dev/enhanced-consumers.html)
- [Monitoring Kinesis Data Streams with CloudWatch](https://docs.aws.amazon.com/streams/latest/dev/monitoring-with-cloudwatch.html)
- [Handling duplicate records](https://docs.aws.amazon.com/streams/latest/dev/kinesis-record-processor-duplicates.html)
- [Server-side encryption in Kinesis Data Streams](https://docs.aws.amazon.com/streams/latest/dev/server-side-encryption.html)
- [Amazon Data Firehose developer guide](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html)
- [Amazon Managed Service for Apache Flink developer guide](https://docs.aws.amazon.com/managed-flink/latest/java/what-is.html)
- [Application scaling in Managed Service for Apache Flink](https://docs.aws.amazon.com/managed-flink/latest/java/how-scaling.html)
- [Using Lambda with Kinesis Data Streams](https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html)
- [Amazon OpenSearch Service operational best practices](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp.html)
- [Apache Flink: generating watermarks](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/event-time/generating_watermarks/)
- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [AWS Well-Architected Data Analytics Lens](https://docs.aws.amazon.com/wellarchitected/latest/analytics-lens/analytics-lens.html)
- [Amazon Kinesis Data Streams pricing](https://aws.amazon.com/kinesis/data-streams/pricing/)
