---
title: "Data lake and lakehouse on AWS: S3, Glue, Lake Formation, Athena, Iceberg and Redshift, done properly"
description: "A production design for a data lake and lakehouse on Amazon S3: raw, curated and gold zones, Apache Iceberg tables, Glue Data Catalog, Lake Formation tags and row and column filters, Athena and Redshift Serverless for consumption, the small-files problem, GDPR erasure, and the cost levers that took a real-shaped lake from $34,000 to about $7,000 a month. Mapped to the AWS Well-Architected pillars, with five incidents and four editable draw.io diagrams."
date: 2026-11-21T03:05:00Z
category: Cloud & DevOps
coverLabel: "Your data lake\non S3, governed\nand affordable."
coverCode: "Iceberg · Lake Formation · Athena"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-s3-data-lake-lakehouse.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Your data lake on S3, governed and affordable.', with the AWS logo."
---
Almost every company that has been on AWS for a few years has a data lake. Most of them didn't design it. It grew: one team dumped clickstream JSON into a bucket, another pointed a Glue crawler at it, somebody connected Athena, and two years later there are 1.2 billion objects, a $27,000 Athena bill, and a spreadsheet that tries to track who is allowed to see customer emails.

This article is the design I'd use to build one on purpose, or to rescue one that grew by accident. It covers the whole path, from ingestion to the dashboard, and the parts people usually leave until something goes wrong: governance, small files, deleting a person's data, and cost.

The example company runs an online marketplace in Europe. The numbers are realistic for a mid-sized business and they're used throughout, so you can see how each decision changes the bill and the query times. There are four diagrams, each an editable `.drawio` file built with the AWS shapes that ship with draw.io, and five incidents at the end written as what happened and what fixed it.

## The short version

- **S3 is the storage, Iceberg is the table, the Glue Data Catalog is the index, Lake Formation is the gate.** Every engine (Athena, Redshift, EMR, Glue) reads the same tables through the same permissions.
- **Three zones, three buckets.** Raw is immutable and short-lived where it holds personal data. Curated is Apache Iceberg. Gold holds the aggregates that dashboards and finance read.
- **Use Iceberg for anything that changes.** CDC merges, late-arriving data, GDPR deletes and schema changes are row-level operations. Plain Parquet folders turn each of them into a partition rewrite.
- **Fix small files at the source.** Buffer at ingestion, compact in the background, and partition by what queries filter on. Millions of tiny objects make every query slow and every request expensive.
- **Make Lake Formation the only way in.** Tag-based grants, row and column filters, and a bucket policy that denies direct `s3:GetObject` to people. Otherwise one IAM policy undoes every column filter.
- **Put limits on spend before you need them.** Athena workgroups with per-query scan cutoffs, Redshift Serverless usage limits, lifecycle rules per zone, and budgets by cost-centre tag.

## Requirements

A data platform without written requirements turns into "store everything forever and give everyone access". These are the ones the example design has to meet. Yours will have different numbers, but you should be able to fill in the same table.

### What the business needs

| Area | Requirement |
|---|---|
| Clickstream | Web and app events, 24,000 per second on average and 60,000 on sale days, about 1 KB each: roughly 2 TB of JSON a day |
| Operational data | 120 tables from three Aurora PostgreSQL clusters (orders, payments, catalogue, customers), queryable within 15 minutes of a change |
| Partner data | Daily CSV files from about 40 sellers and logistics partners over SFTP |
| Analysts | 200 analysts writing ad-hoc SQL; 90% of queries on curated tables finish in under 10 seconds |
| Dashboards | 500 business users on dashboards that load in under 2 seconds, refreshed hourly |
| Finance | Daily revenue and margin tables ready by 07:00 CET, reproducible for any past date |
| Data science | Spark and notebooks on two years of history, without copying data to a separate store |

### What the platform has to guarantee

| Area | Requirement |
|---|---|
| Access | Column-level control for personal data (email, phone, date of birth), row-level control by country, and an audit trail of who read what |
| Privacy | GDPR erasure requests (around 4,000 a month) fully removed from every zone within 30 days |
| Retention | Clickstream with personal data kept 90 days raw and 25 months curated; finance records kept 7 years |
| Durability | Raw data recoverable from accidental deletes and overwrites; curated tables restorable to any point in the last 7 days |
| Freshness | Curated CDC tables at most 15 minutes behind; an alarm if any table falls more than an hour behind |
| Cost | A monthly budget per team, and no single query able to cost more than a few dollars without an engineer's say-so |

The two lines that shape the design most are the 15-minute CDC freshness, which rules out "rewrite the whole table nightly", and the 30-day erasure, which rules out file formats that can't delete a row.

## The architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-reference.svg" alt="Reference architecture. Sources on the left: web and mobile apps sending clickstream at 24,000 events per second on average and 60,000 at peak, three Aurora PostgreSQL clusters with 120 tables, and partner CSV files over SFTP. Ingest: Amazon Data Firehose with dynamic partitioning and a 128 MiB or 300 second buffer, AWS DMS doing full load plus change data capture as Parquet, and AWS Transfer Family as a managed SFTP endpoint. All three land in the raw zone of a data lake account in eu-west-1. A catalog and governance band holds the Glue Data Catalog, Lake Formation with LF-Tags and row and column filters, Macie for PII discovery on raw, KMS with one key per zone, and CloudTrail for data access audit. Three zones: raw (bronze), a versioned S3 bucket with SSE-KMS holding JSON, CSV and CDC Parquet kept 90 days for personal data or 7 years for finance; curated (silver), Apache Iceberg tables in a general purpose bucket or S3 Tables, Parquet with zstd in 512 MB files supporting MERGE, DELETE and time travel; and consumption (gold), Iceberg aggregates in Intelligent-Tiering such as daily revenue, funnels and customer 360. Processing below: AWS Glue Spark jobs that MERGE CDC into Iceberg every 15 minutes, EMR Serverless for backfills and feature builds, Glue Data Quality rules that gate each publish, Step Functions or MWAA for orchestration, and table optimizers for compaction, snapshot expiry and orphan file removal. An operate band has S3 Storage Lens, CloudWatch freshness alarms and Budgets with Cost Anomaly Detection. On the right, consumers read through Lake Formation: Athena for 200 analysts with workgroup scan limits, Redshift Serverless for 500 dashboard users joining local tables with Iceberg, QuickSight with SPICE and row-level security, and SageMaker for notebooks and training." width="1500" height="900" loading="lazy"></a><figcaption>The whole platform on one page. Numbers in circles match the steps below.</figcaption></figure>

### 1. Ingest without creating a mess

Each source gets the managed service that fits its shape, and every one of them lands in the raw zone first.

- **Clickstream goes through Amazon Data Firehose.** The SDK in the app batches about 20 events into each record, Firehose buffers up to 128 MiB or 300 seconds, compresses with GZIP, and uses dynamic partitioning to write `raw/clicks/dt=2026-11-03/` prefixes. That buffer is the first and cheapest defence against small files. It also matters for the bill: Firehose rounds each ingested record up to the next 5 KB, so sending 1 KB events one per record means paying for five times the data you send.
- **Databases go through AWS DMS.** A full load, then ongoing change data capture from the PostgreSQL write-ahead log, written to S3 as Parquet with an operation column (`I`, `U`, `D`) and a commit timestamp. If the only consumer of a table is Redshift, an Aurora zero-ETL integration with Redshift is less to run; DMS is here because the lake, not the warehouse, is the system of record for analytics.
- **Partner files come in through AWS Transfer Family.** A managed SFTP endpoint that writes straight into `raw/partners/<partner>/`, with an S3 event that starts validation. Nobody runs an EC2 instance with an SFTP daemon on it any more.

### 2. Raw zone: keep what arrived, briefly

The raw bucket holds data exactly as it was delivered. It's versioned, encrypted with SSE-KMS using an S3 Bucket Key (which cuts KMS request costs by up to 99%), and nothing except the ingestion roles can write to it.

Raw is for replay and debugging, not for analysts. If a transformation has a bug, you fix it and rebuild the curated table from raw. That's why raw keeps clickstream for 90 days: long enough to catch and fix a bad job, short enough that personal data doesn't pile up somewhere no one is deleting it from.

### 3. Curated zone: Apache Iceberg tables

This is where the "lakehouse" part comes from. A curated table is an Apache Iceberg table: Parquet files (with zstd compression) plus Iceberg metadata that tracks exactly which files belong to which snapshot of the table. That gives you, on plain S3:

- **ACID commits.** A Glue job merging CDC and an analyst running a query never see a half-written table.
- **Row-level `MERGE`, `UPDATE` and `DELETE`.** The CDC job runs `MERGE INTO curated.orders` every 15 minutes, using the operation column from DMS. Deleting one customer doesn't mean rewriting a partition by hand.
- **Hidden partitioning.** The table is partitioned by `day(event_ts)`, and queries filter on `event_ts`. Nobody needs to know a `dt` column exists, and a later change to monthly partitions doesn't break a single query.
- **Schema evolution by column ID.** Adding, renaming or reordering a column is a metadata change, not a rewrite, and it doesn't silently shift data into the wrong column.
- **Time travel.** Finance can rerun the 3 November revenue report against the table exactly as it was at 07:00 on 4 November with `FOR TIMESTAMP AS OF`.

You have two ways to store Iceberg on S3. **Self-managed Iceberg in a general purpose bucket**, registered in the Glue Data Catalog, gives you full control and works with every engine. **Amazon S3 Tables** gives you table buckets where S3 manages the Iceberg tables for you, including compaction, snapshot management and unreferenced file removal; AWS quotes up to 3x faster queries and up to 10x more transactions per second than self-managed tables in general purpose buckets. For a new lake I'd start with S3 Tables for high-churn tables like clickstream and CDC, and check that every engine and feature you need (including the Lake Formation integration you plan to use) supports it in your region before committing.

### 4. Catalog and governance

The **Glue Data Catalog** holds the table definitions for every engine. There's one per account per region, so the data lake account owns it and other accounts reach it through Lake Formation sharing.

Crawlers are for discovering raw data you don't control, like partner CSVs. Curated tables are created by code (Spark or Athena DDL in the same repository as the job that writes them), and a crawler is never pointed at an Iceberg table, because it will try to "help" by creating a Hive table on top of the data files.

**Lake Formation** decides who can read what. The next section covers how. **Macie** scans the raw buckets for personal data, so a new partner file that unexpectedly contains phone numbers is found before it's promoted. **CloudTrail** records every Lake Formation data access, with the principal who asked.

### 5. Processing and consumption

- **AWS Glue (Spark)** runs the CDC merges and most transformations. **EMR Serverless** takes the jobs that are too big or too custom for Glue, like a two-year backfill or feature engineering with special libraries.
- **Glue Data Quality** rules run before a curated or gold table is published: row counts within 20% of the same weekday last week, no null `order_id`, revenue totals that reconcile with the payments table. A failed rule stops the publish and alerts, so a bad load never reaches the 07:00 finance report.
- **Step Functions** or **Amazon MWAA** (managed Airflow) orchestrate the jobs. Pick Step Functions if you mostly chain AWS services; pick MWAA if your team already writes Airflow DAGs.
- **Athena** is the default for ad-hoc SQL. It's serverless, priced per data scanned, and reads Iceberg natively, including `MERGE`, `OPTIMIZE` and `VACUUM`.
- **Redshift Serverless** serves dashboards. Five hundred people opening the same dashboard at 09:00 is a concurrency problem, and that's what a warehouse with result caching and workload management is good at. Redshift reads the same Iceberg tables through the Data Catalog and joins them with its own tables, so hot aggregates can live in Redshift without a separate copy of the lake.
- **QuickSight** sits on top, with SPICE for the most used dashboards. **SageMaker** notebooks and pipelines read curated tables through the same permissions.

### When you need Redshift, and when Athena is enough

| Workload | Athena on Iceberg | Redshift Serverless |
|---|---|---|
| Ad-hoc queries by analysts, a few at a time | Best fit. No infrastructure, pay per TB scanned | Works, but you pay for compute while it waits |
| Dashboards with hundreds of concurrent users | Concurrency quotas and per-query cost add up | Best fit. Result cache, workload management, predictable latency |
| Heavy joins across big fact tables, every hour | Possible, can get expensive | Better: sort keys, materialized views, local storage |
| Data shared with another account | Lake Formation sharing | Redshift data sharing, or Lake Formation |
| One copy of the data for every engine | Yes | Yes, when it queries Iceberg through the Data Catalog |

Most lakes end up with both. The mistake is loading everything into Redshift "for performance" and running two copies of every table, or running dashboards on Athena and paying per scan for the same query 500 times a morning.

## Governance with Lake Formation

<figure class="diagram wide"><a href="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-governance.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-governance.svg" alt="Governance with Lake Formation. Four principals from IAM Identity Center: analyst-eu, with the sales domain, EU rows and no PII columns; finance, with finance and sales including PII for all countries; data-scientist, with internal tables and tokenised customer IDs only; and etl-orders, a Glue job role that writes curated.orders and reads raw orders. They use Athena, Redshift Serverless, EMR Serverless and AWS Glue respectively. Every engine asks Lake Formation in the data lake account, which runs three steps: a grant check that the principal holds SELECT through an LF-Tag expression matching the table and column; a data cell filter, for example rows where country is in DE, FR, NL, ES or IT and all columns except email, phone and date of birth; and credential vending, which issues short-lived credentials scoped to the table's registered S3 prefix to the engine only. LF-Tags are domain equal to sales, finance or marketing, and sensitivity equal to public, internal or pii. A note says to use hybrid access mode while migrating, then remove IAMAllowedPrincipals so IAM alone grants nothing. The curated bucket on the right is a registered location with a KMS key whose policy lets only the LF data-access role and ETL roles decrypt, and a bucket policy that denies GetObject and PutObject unless the principal is the Lake Formation role or an approved ETL role, and requires TLS and the organization ID. A red dashed path shows analyst-eu trying to copy objects from the bucket directly and getting AccessDenied. A bottom band shows Macie tagging columns as PII through EventBridge and Lambda, CloudTrail recording GetDataAccess and Athena query events per principal, a business catalog in DataZone or SageMaker Unified Studio, and cross-account sharing through AWS RAM with a resource link in the marketing account." width="1500" height="820" loading="lazy"></a><figcaption>Every engine asks Lake Formation, Lake Formation filters, and the direct path to S3 stays closed.</figcaption></figure>

### Grant on tags, not on tables

With 600 tables and a dozen roles, granting table by table is how permissions drift. Lake Formation tag-based access control (LF-TBAC) lets you tag databases, tables and columns, and grant on a tag expression instead:

- `domain = sales | finance | marketing | logistics`
- `sensitivity = public | internal | pii`

The `analyst-eu` role gets `SELECT` on `domain = sales AND sensitivity IN (public, internal)`. A new sales table tagged by the pipeline that creates it is readable by the right people the moment it exists, without a ticket. A column tagged `pii` is invisible to that role even inside a table it can read.

### Rows and columns: data cell filters

Tags decide which tables and columns. Data cell filters add rows. The EU sales analysts get a filter on `curated.orders` with the row expression `country IN ('DE','FR','NL','ES','IT', ...)` and all columns except `email`, `phone` and `date_of_birth`. The finance role gets no filter. The data scientists get a separate view of customers where `customer_id` is replaced by a keyed hash, so they can join tables without ever seeing who a customer is.

Athena, Redshift and EMR all enforce Lake Formation permissions, but support for fine-grained features differs by engine and version. Check the engine's documentation for row and cell filters before you design around one.

### Close the side door

This is the part most lakes get wrong. Lake Formation filters what comes back through an engine. It can't filter what someone reads straight out of S3. If `analyst-eu` has an old IAM policy with `s3:GetObject` on the curated bucket, they can download the Parquet files and read every email address, and Lake Formation never sees it.

So the design does three things:

1. **Register the curated and gold locations with Lake Formation** and let it vend credentials. Engines get short-lived credentials scoped to the table's prefix; people don't need S3 permissions at all.
2. **Use hybrid access mode while migrating**, then remove `IAMAllowedPrincipals` from databases and tables, so IAM permissions alone grant nothing.
3. **Deny direct access in the bucket policy**: `s3:GetObject` and `s3:PutObject` are denied unless `aws:PrincipalArn` is the Lake Formation data-access role or an approved ETL role. The KMS key policy matches, so even a misconfigured bucket policy can't hand out readable data. If you've run into a deny that seems to override an allow, the [explicit deny article](/blog/cloud-iam-explicit-deny/) explains the evaluation order, and [envelope encryption with KMS](/blog/cloud-kms-envelope-encryption/) explains why a separate key per data class is worth having.

### Audit and sharing

CloudTrail logs a `GetDataAccess` event from Lake Formation for every credential it vends, and Athena logs every query with the calling principal. Send both to the organisation trail and you can answer "who read the customers table last month" with one query.

Other accounts (the marketing team has its own) get data through Lake Formation cross-account grants, which use AWS RAM underneath. The consuming account creates a resource link in its own catalog, and the owning account keeps control of every permission. If you want a business-facing catalog where people request access and owners approve it, Amazon DataZone (now part of SageMaker Unified Studio) sits on top of the same catalog and Lake Formation permissions, so nothing here has to be rebuilt.

## The small-files problem

<figure class="diagram wide"><a href="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-small-files.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-small-files.svg" alt="The small-files problem, before and after. Before: web and mobile clients at 24,000 events per second feed Kinesis Data Streams with 40 shards, a Lambda consumer takes batches of about 600 records and writes one S3 object per batch into raw clicks partitioned by date and hour: 40 objects per second averaging 0.6 MB, 3.46 million objects a day. An Athena query over one day of clicks takes 5 minutes 40 seconds, makes 3.46 million GET requests and hits S3 503 Slow Down retries. Why it hurts: every file is a request to list, open and read a footer from, planning time grows with file count rather than data size, and GETs per prefix hit the 5,500 requests per second guidance and get throttled. Monthly side effects: about 105 million new objects and about 525 dollars in PUT requests alone, 1.26 billion objects in the raw zone after a year, and Glue crawler runs that take hours and add a partition per hour. After: the SDK packs about 20 events per record, Data Firehose buffers 128 MiB or 300 seconds with GZIP and dynamic partitions, writing a few thousand objects a day to raw; an hourly Glue job inserts into the Iceberg table curated.clicks with hidden partitioning by day, about 220 GB a day of Parquet with zstd; Athena's query over one day takes 14 seconds over about 450 data files, scanning 11 GB for 3 of 60 columns, about 6 cents. Table maintenance through Glue Data Catalog optimizers, or built in with S3 Tables: compaction bin-packing to 512 MB files and rewriting delete files, snapshot expiry keeping 7 days, and orphan file removal after 3 days. Firehose can also write straight into Iceberg if no raw copy is needed. Rules of thumb: aim for 128 MB to 1 GB per data file, partition by what queries filter on, watch average object size in S3 Storage Lens and the Iceberg files metadata table, and never point a crawler at an Iceberg table." width="1500" height="800" loading="lazy"></a><figcaption>The same clickstream and the same query, before and after fixing file sizes.</figcaption></figure>

Small files are the most common reason a data lake is slow and expensive, and they're almost always self-inflicted.

Every Parquet file a query touches costs at least one `LIST`, a `GET` for the footer and a `GET` for each column chunk it reads. The query engine also has to plan the work, and planning time grows with the number of files, not the amount of data. A day of clickstream as 450 files of 512 MB is a small job. The same 220 GB as 3.46 million files of 64 KB to 600 KB is a very large one. On top of that, S3 supports at least 5,500 `GET` requests per second per prefix. That is a lot, until thousands of query tasks hit one day's prefix at once and get `503 Slow Down`.

Where small files come from:

- **A streaming consumer that writes one object per batch.** Lambda reading Kinesis and calling `PutObject` for every invocation is the classic case.
- **Over-partitioning.** `dt=/hr=/country=/device=` turns one day into thousands of folders, each with a few tiny files. Partition by what nearly every query filters on, which is usually just the day.
- **Frequent small writes to a table.** A `MERGE` every 15 minutes adds new data files and, in merge-on-read mode, delete files, every time.
- **Spark with too many output partitions.** A job with 2,000 shuffle partitions writing a 4 GB result produces 2,000 files of 2 MB.

How to fix them, in order of how cheap the fix is:

1. **Buffer at ingestion.** Firehose with a 128 MiB buffer, a client that packs events into records, a Spark job that coalesces before writing.
2. **Write Iceberg with a sensible target size.** Iceberg's default target file size is 512 MB; leave it, or lower it for tables that are always read by narrow filters.
3. **Compact in the background.** Turn on the Glue Data Catalog table optimizers for each Iceberg table (compaction, snapshot retention and orphan file deletion), or let S3 Tables do it. You can also run `OPTIMIZE ... REWRITE DATA USING BIN_PACK` from Athena for a one-off. Compaction also rewrites the delete files left by `MERGE` and `DELETE`, which keeps reads fast.
4. **Measure it.** S3 Storage Lens shows average object size per bucket and prefix. Iceberg's `$files` metadata table shows file counts and sizes per partition. Alarm when the average data file in a curated table drops below 64 MB.

## Deleting a person's data, properly

GDPR erasure is where data lakes built on plain Parquet folders fail. To delete one customer from three years of clickstream stored as Parquet, you find every file that contains them and rewrite it. With 4,000 requests a month, that's most of the table, every month.

With Iceberg, the curated job batches the week's requests and runs:

```sql
DELETE FROM curated.clicks
WHERE customer_id IN (SELECT customer_id FROM governance.erasure_requests WHERE batch = '2026-W45');
```

That writes delete files, which hide the rows from every query immediately. But the data is still physically in S3 in four places, and the 30-day promise only holds if you account for all of them:

| Where the data still is | What removes it | Time it takes in this design |
|---|---|---|
| Original data files, now masked by delete files | Compaction rewrites the files without the deleted rows | Nightly, so within 1 day |
| Older snapshots that still reference the original files | Snapshot expiry, keeping 7 days | 7 days |
| Noncurrent object versions, because the bucket is versioned | Lifecycle rule expiring noncurrent versions | 7 days on curated buckets |
| Raw zone copies | Raw clickstream expires at 90 days | Too long, so raw identifiers are pseudonymised at ingestion |

Add it up: up to 7 days waiting for the weekly batch, 1 day for compaction, 7 for snapshot expiry and 7 for noncurrent versions comes to 22 days, inside the 30-day limit. The first version of this design kept noncurrent versions for 30 days and missed the target. Write the table above for your own lake; it's the question a data protection officer will ask.

Finance records are the exception: tax law requires keeping them for years, and GDPR allows that where there's a legal obligation. They live in separate tables with their own retention, and personal fields in them are minimised to what the law requires.

## Storage classes and cost controls

<figure class="diagram wide"><a href="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-lifecycle-cost.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-lifecycle-cost.svg" alt="Lifecycle and cost guardrails. A timeline from day 0 to 7 years shows storage class by zone. Raw clicks, which contain IP addresses and user IDs: S3 Standard for 30 days, Standard-IA from 30 to 90 days, then expired at 90 days. Raw orders CDC, a finance record: Standard for 30 days, Glacier Flexible Retrieval from 30 days to 1 year, Glacier Deep Archive from 1 to 7 years. Curated Iceberg tables: Intelligent-Tiering from day 0, moving to Infrequent Access after 30 idle days and Archive Instant Access after 90. Gold aggregates stay in Standard. Notes: every bucket expires noncurrent versions after 30 days and aborts incomplete multipart uploads after 7 days; clicks leave curated through Iceberg DELETE at 25 months, not lifecycle, because lifecycle on a table's files corrupts it; minimum storage durations apply, and transitions cost per object, so lifecycle on millions of tiny files can cost more than it saves. Guardrails: Athena workgroups with a per-query scan cutoff of 200 GB for analysts and 2 TB for engineering, enforced settings and result reuse up to 60 minutes; Redshift Serverless with base 32 RPU, a maximum RPU cap and a daily RPU-hours usage limit; Glue with Flex execution, auto scaling and job timeouts; Budgets and Cost Anomaly Detection by CostCentre tag and workgroup, alerting at 80 percent of forecast. Results for the example lake, monthly at us-east-1 list prices: S3 storage of 331 TB costs about 7,300 dollars all in Standard and about 2,100 with this lifecycle; Athena scans drop from 180 TB a day costing 27,000 dollars on JSON with no partitions to 2.7 TB a day costing about 400 dollars on Iceberg and Parquet; the largest single query drops from 140 TB scanned costing 700 dollars to being stopped at the 200 GB cutoff for 1 dollar; and clickstream PUT requests fall from 525 dollars to under 5." width="1500" height="780" loading="lazy"></a><figcaption>Storage class by zone and age on the left, hard limits on query spend on the right.</figcaption></figure>

### Lifecycle, zone by zone

- **Raw clickstream:** Standard for 30 days, then Standard-IA, then expire at 90 days. Not Glacier Instant Retrieval: it has a 90-day minimum storage charge, so moving objects in at day 30 and deleting them at day 90 pays for 30 days you didn't use.
- **Raw finance CDC:** Standard for 30 days, Glacier Flexible Retrieval until one year, Glacier Deep Archive until seven years, then expire. This is the data you hope to never read again and must be able to produce if asked.
- **Curated Iceberg tables:** S3 Intelligent-Tiering from day 0. Access patterns on curated data are unpredictable (last month is hot, last year is warm during planning season), and Intelligent-Tiering moves objects between tiers with no retrieval fees. Its monitoring fee is per object, which is one more reason to have 512 MB files instead of 64 KB ones; objects under 128 KB aren't tiered at all.
- **Never put a lifecycle expiration on a curated table's data files.** S3 would delete files the Iceberg metadata still points to, and the table breaks. Old data leaves an Iceberg table through `DELETE` plus snapshot expiry.
- **Every bucket:** expire noncurrent versions (7 days on curated, 30 on raw) and abort incomplete multipart uploads after 7 days. Failed Spark jobs leave a surprising amount of invisible, billable multipart data behind.

### Limits on query spend

- **Athena workgroups per team**, with "override client-side settings" on, so queries can't pick their own output location or skip limits. A per-query data scanned cutoff (200 GB for analysts, 2 TB for data engineering) cancels a runaway query instead of billing it. A workgroup-level data usage alarm warns when a team passes 20 TB in a day. Query result reuse serves a repeated query from the last result for up to 60 minutes.
- **Redshift Serverless** with a base capacity sized for the morning peak (32 RPUs here), a maximum capacity cap, and a usage limit on RPU-hours per day that alerts first and stops queries only as a last resort.
- **Glue** jobs with timeouts and auto scaling, and Flex execution for jobs that can wait, like the nightly backfills: Flex uses spare capacity at a lower price per DPU-hour.
- **AWS Budgets and Cost Anomaly Detection** by `CostCentre` tag and Athena workgroup, so a new team's runaway job is noticed within a day, not at month end.

### What it adds up to

Monthly estimates for the example lake at us-east-1 list prices. Ireland is within a few percent. They're here to show the size of each lever, not to replace the AWS Pricing Calculator.

| Line | Before (grown by accident) | After (this design) |
|---|---|---|
| S3 storage, 331 TB | about $7,300, everything in Standard | about $2,100 with lifecycle and Intelligent-Tiering |
| Athena | about $27,000: 180 TB scanned a day over JSON with no partitions | about $400: 2.7 TB a day over Iceberg, Parquet and day partitions |
| S3 PUT requests, clickstream | about $525 | under $5 |
| Glue: CDC merges every 15 minutes, compaction | not in place | about $1,600 |
| Redshift Serverless, 32 RPU base, about 10 busy hours on weekdays | not in place | about $2,600 |
| **Total of these lines** | **about $34,800** | **about $6,700** |

The new design spends money the old one didn't, on Glue and Redshift, and is still about a fifth of the cost. Nearly all of the saving is Athena: columnar files, partition pruning and reading 3 columns out of 60 are what make a lake cheap to query.

## Five incidents, and what fixed them

These are composites of things that happen in real lakes. The numbers come from the example platform.

### 1. The Monday morning query timeouts

**What happened.** Analysts' queries on the clickstream table started timing out on Monday mornings. Weekend sale traffic had doubled the file count. A query over one day of clicks took 5 minutes 40 seconds and showed `503 Slow Down` retries in the engine logs. The raw prefix held 3.46 million objects for that single day.

**Why.** A Lambda function consuming Kinesis wrote one object per invocation: about 40 objects a second, averaging 0.6 MB. The table was a Hive-style table pointing straight at those files.

**What fixed it.** Firehose with a 128 MiB buffer for ingestion, an hourly Glue job writing into an Iceberg table partitioned by day, and the Glue compaction optimizer targeting 512 MB files. The same query now reads about 450 files and takes 14 seconds. The clean-up job that rewrote the old year of tiny files paid for itself in the first month of avoided requests.

### 2. The $700 query

**What happened.** A new analyst ran `SELECT * FROM raw_clicks WHERE user_agent LIKE '%bot%'` with no date filter. Athena scanned 140 TB of JSON and the query cost $700. Nobody noticed until finance asked about the Athena line on the invoice.

**What fixed it.** Analysts lost access to the raw zone entirely (they read curated tables). Their Athena workgroup got a 200 GB per-query scan cutoff and enforced settings, and a CloudWatch alarm on the workgroup's daily bytes scanned. The same query today is cancelled at 200 GB, about $1, with an error message that tells the analyst which table to use instead.

### 3. Email addresses in a notebook

**What happened.** A data scientist's notebook contained customer email addresses, although the `data-scientist` role had a Lake Formation filter excluding the `email` column. A review of CloudTrail found the notebook had read Parquet files directly with `s3:GetObject`, not through Athena or Glue.

**Why.** The role still had a broad S3 read policy from before Lake Formation was introduced, and the bucket allowed any principal in the account with IAM permission.

**What fixed it.** The bucket policy and KMS key policy now deny reads unless the caller is the Lake Formation data-access role or an approved ETL role. Data scientists read through Lake Formation-aware engines, which vend credentials scoped to what they're granted. `IAMAllowedPrincipals` was removed from all curated databases. A quarterly access review now checks for any human role with `s3:GetObject` on a lake bucket, and the answer should always be none.

### 4. The erasure request that took up to 52 days

**What happened.** An audit sampled ten GDPR erasure requests and found that, for three, the customer's events were still in S3 after 30 days. They didn't show up in queries, but the files were there.

**Why.** The `DELETE` was correct and the rows were hidden at once. But snapshot expiry had been set to 14 days, the bucket's noncurrent versions were kept for 30, and the weekly batch could add another 7. Worst case was 52 days.

**What fixed it.** Nightly compaction, 7-day snapshot retention, 7-day noncurrent version expiry on curated buckets, and identifiers in raw clickstream pseudonymised at ingestion so the 90-day raw retention no longer holds anything that identifies a person directly. The erasure table in the previous section is now part of the platform's runbook, with the worst case recalculated whenever a retention setting changes.

### 5. The schema change that broke the 07:00 report

**What happened.** The orders team renamed `discount` to `discount_amount` and changed it from integer cents to a decimal. The nightly crawler on the old Hive table created a new schema version, Athena queries failed with `HIVE_BAD_DATA`, and the finance report was late by three hours.

**What fixed it.** Curated tables are Iceberg tables created by code, with no crawler, so a rename is an explicit `ALTER TABLE ... RENAME COLUMN` in the pipeline's pull request, and old snapshots still read correctly. A Glue Data Quality ruleset on `curated.orders` checks that `discount_amount` is non-null and that daily totals reconcile with payments before the gold tables are published. The orders team's CDC changes now go through a schema contract check in CI, and the 07:00 report has a freshness alarm at 06:30.

## Mapped to the Well-Architected pillars

The AWS Well-Architected Framework has a Data Analytics Lens with questions specific to this kind of platform. This is how the design answers each pillar.

| Pillar | Decisions in this design |
|---|---|
| Operational excellence | Tables, jobs and permissions defined in code and deployed by CI; Glue Data Quality gates every publish; freshness alarms per table; runbooks for erasure and backfill |
| Security | Lake Formation as the only read path, tag-based grants, row and column filters, a bucket policy denying direct reads, one KMS key per zone, Macie on raw, CloudTrail data access audit |
| Reliability | Raw zone kept immutable and versioned for replay; Iceberg ACID commits and 7-day time travel; idempotent CDC merges keyed on commit timestamp; jobs that rebuild curated from raw |
| Performance efficiency | Columnar Parquet with zstd, 512 MB files, partitions on what queries filter, compaction, Athena for ad-hoc and Redshift for high-concurrency dashboards |
| Cost optimization | Lifecycle per zone, Intelligent-Tiering on curated, Athena scan cutoffs, Redshift usage limits, Glue Flex for jobs that can wait, budgets by team |
| Sustainability | Fewer bytes stored and scanned: compression, column pruning, expiring what you don't need, and serverless engines that don't idle |

## Production-readiness checklist

- Three buckets per environment (raw, curated, gold), each with SSE-KMS, a Bucket Key, versioning and Block Public Access
- Curated and gold locations registered with Lake Formation; `IAMAllowedPrincipals` removed
- Bucket and KMS key policies deny reads except to the Lake Formation role and named ETL roles
- LF-Tags for domain and sensitivity applied by the pipelines that create tables
- Data cell filters for every role that must not see personal data or all countries
- Every curated table is Iceberg, created by code, with compaction, snapshot retention and orphan file removal on
- Average data file size alarmed per table; no crawlers on curated
- Glue Data Quality rules gate publishing to gold
- Lifecycle rules per zone, including noncurrent versions and incomplete multipart uploads
- Athena workgroups per team with enforced settings and a per-query scan cutoff
- Redshift Serverless base and maximum capacity and an RPU-hours usage limit
- Budgets and Cost Anomaly Detection on cost-centre tags
- An erasure runbook with the worst-case timeline written down and tested
- A rebuild-from-raw run for one curated table, timed, in the last quarter

If you're building this with Terraform, the [Terraform on AWS enterprise guide](/blog/terraform-aws-enterprise-guide/) covers the account layout and state structure that the lake account fits into.

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the account names, regions and numbers to match your platform.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-s3-data-lake-lakehouse/aws-s3-data-lake-lakehouse.drawio)
- [Reference architecture](/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-reference.drawio)
- [Governance with Lake Formation](/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-governance.drawio)
- [The small-files problem](/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-small-files.drawio)
- [Lifecycle and cost guardrails](/assets/diagrams/aws-s3-data-lake-lakehouse/s3-lakehouse-lifecycle-cost.drawio)

Volumes, prices and limits are examples from public list prices at the time of writing. Check current quotas, prices and regional availability for your own regions before you build.

## References

- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [Data Analytics Lens, AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/analytics-lens/analytics-lens.html)
- [What is AWS Lake Formation?](https://docs.aws.amazon.com/lake-formation/latest/dg/what-is-lake-formation.html)
- [Lake Formation tag-based access control](https://docs.aws.amazon.com/lake-formation/latest/dg/tag-based-access-control.html)
- [Data filtering and cell-level security in Lake Formation](https://docs.aws.amazon.com/lake-formation/latest/dg/data-filtering.html)
- [Lake Formation hybrid access mode](https://docs.aws.amazon.com/lake-formation/latest/dg/hybrid-access-mode.html)
- [Query Apache Iceberg tables with Athena](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg.html)
- [Athena workgroup data usage controls](https://docs.aws.amazon.com/athena/latest/ug/workgroups-setting-control-limits-cloudwatch.html)
- [Amazon S3 Tables](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables.html)
- [Optimizing Iceberg tables in the Glue Data Catalog](https://docs.aws.amazon.com/glue/latest/dg/table-optimizers.html)
- [Amazon Data Firehose dynamic partitioning](https://docs.aws.amazon.com/firehose/latest/dev/dynamic-partitioning.html)
- [Using Amazon S3 as a target for AWS DMS](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Target.S3.html)
- [Querying Apache Iceberg tables from Amazon Redshift](https://docs.aws.amazon.com/redshift/latest/dg/querying-iceberg.html)
- [AWS Glue Data Quality](https://docs.aws.amazon.com/glue/latest/dg/glue-data-quality.html)
- [Amazon S3 performance guidelines](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)
- [S3 Intelligent-Tiering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering-overview.html)
- [S3 Bucket Keys for SSE-KMS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)
- [What is Amazon Macie?](https://docs.aws.amazon.com/macie/latest/user/what-is-macie.html)
