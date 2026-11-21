---
title: "Cost-optimized and sustainable AWS architecture: how a doubled bill came back down with FinOps"
description: "A real-world FinOps playbook for AWS: tagging and showback, Graviton, Spot, Savings Plans, rightsizing, storage tiering and the Customer Carbon Footprint Tool, walked through a $236k monthly bill that came down to $105k without touching the SLOs. Mapped to the Well-Architected Cost Optimization and Sustainability pillars, with four editable draw.io diagrams."
date: 2026-11-21T03:16:00Z
category: Cloud & DevOps
coverLabel: "More customers.\nHalf the bill.\nLess carbon."
coverCode: "$236k → $105k / month"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-cost-optimization-sustainability-finops.jpg
coverImageAlt: "Cloud & DevOps cover reading 'More customers. Half the bill. Less carbon.', with the AWS logo."
---
Nobody plans for the AWS bill to double. It happens one reasonable decision at a time. A feature launches on bigger instances "just for the first week". Debug logging goes on during an incident and stays on. A database gets scaled up at 2 a.m. and nobody scales it back. Each change is small, and none of them shows up anywhere a team would look.

This article is the story of a bill that went from $118k to $236k a month in nine months, and how it came back down to $105k in four, while customers and traffic kept growing. It is also the architecture I'd put in place on day one so it doesn't happen again: who sees the bill, who owns each line of it, and which levers to pull in which order.

Cost and carbon are covered together on purpose. On AWS, almost everything that cuts waste also cuts emissions: fewer idle instances, busier instances, newer and more efficient chips, less data stored and moved. The Well-Architected Framework treats them as two pillars, but in practice it's one programme with two scorecards.

There are four diagrams, each one an editable `.drawio` file built with draw.io's own AWS shapes. You can download them at the end.

<figure class="diagram wide"><a href="/assets/diagrams/aws-finops/aws-finops-hld.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-finops/aws-finops-hld.png" alt="FinOps control plane on AWS. Inside one AWS Organization, guardrails at the root: a tag policy for the tags team, service, env and cost-center, and an SCP that denies creating resources without those tags. Three workload accounts on the left: a prod account with EKS and Karpenter, Aurora and S3; a non-prod account with dev and test EC2, Instance Scheduler and RDS; and a data account with EMR on Spot, an S3 data lake and Glacier Deep Archive. Their usage and tags flow into the management (payer) account, which runs no workloads and holds Cost Explorer with cost allocation tags, Cost Categories that map tags to teams and products, Data Exports producing hourly CUR 2.0 and FOCUS data with split cost allocation for EKS, Budgets with budget actions per team, Cost Anomaly Detection per service and cost category, Savings Plans and Reserved Instances bought once and shared across the organization, and the Customer Carbon Footprint Tool showing estimated emissions by service and Region. Data Exports writes to an S3 bucket in a FinOps tooling account, where a Glue crawler and Data Catalog, Athena and QuickSight Cloud Intelligence Dashboards turn it into per-team showback. A recommendations box holds Compute Optimizer, Trusted Advisor and Cost Optimization Hub. Budget and anomaly alerts go through SNS to the owning team's chat channel. Team owners get monthly showback and a weekly FinOps review, and act in their own accounts by rightsizing, scheduling and moving to Graviton and Spot. Commitments are a central decision; usage and rightsizing belong to the teams." width="1640" height="1000" loading="lazy"></a><figcaption>The FinOps control plane: tags enforced at the root, one hourly bill in S3, showback per team, alerts to the people who can fix the cause.</figcaption></figure>

## The short version

- **Make the bill visible per team before you cut anything.** Enforced tags, CUR 2.0 in S3, a showback dashboard per team and anomaly alerts that go to the owner, not to a shared finance inbox.
- **Remove waste first, then rightsize, then change the price.** Orphaned volumes, idle non-prod, NAT traffic that should use endpoints, logs nobody reads. Waste and rightsizing were 70% of the savings here.
- **Make Graviton the default.** Build multi-arch images once, prefer `arm64` in every node pool, and move managed databases and caches to Graviton instance types.
- **Use Spot for anything that can restart.** Stateless web pods, queue workers, CI, batch. Diversify across many instance types and let Karpenter handle the two-minute notice.
- **Commit last, and only to the floor.** Savings Plans for the usage you are sure of every hour of the year, sized after the waste is gone. On-demand and Spot for everything above it.
- **Tier storage by default.** S3 Intelligent-Tiering for data with unknown access patterns, lifecycle rules for data you know is cold, gp3 instead of gp2.
- **Track carbon next to cost.** The Customer Carbon Footprint Tool for the trend, and a proxy metric you can see daily, such as vCPU-hours per customer.

## The scenario: a bill that doubled

The company sells a B2B reporting product. Around 2,000 customers, one main Region (eu-west-1), services on Amazon EKS, Aurora PostgreSQL for the product database, an S3 data lake processed by EMR, and a platform team of four.

Last October the bill was $118k a month for 1,600 customers. By July it was $236k for 2,000. Customers grew 25%; the bill grew 100%. Cost per active customer went from $74 to $118 a month, and the CFO asked the question every platform team eventually gets: "what are we paying for?"

Nobody could answer in under a week. That was the first problem.

When we did dig in, the causes were all ordinary:

| Line of the bill | July ($k / month) | What had happened |
| --- | --- | --- |
| EC2 for EKS and non-prod | 92 | x86 on-demand everywhere. Pod requests set to 3-4x real use, so nodes ran at 31% CPU. Feature-branch environments created by CI and never deleted. |
| Aurora and ElastiCache | 34 | Writer scaled to r5.4xlarge during an incident in March, two readers to match, never scaled back. Peak CPU 22%. |
| NAT gateway and data transfer | 27 | Every container image pull and every EMR read from S3 went through NAT gateways. Chatty services called each other across AZs. |
| S3 | 24 | Versioning on, no lifecycle rules. 40% of the bytes were noncurrent versions and incomplete multipart uploads. |
| CloudWatch Logs | 18 | Debug logging switched on in March, never switched off. Retention set to "never expire". |
| EBS | 14 | gp2 volumes from old launch templates, 300+ unattached volumes, snapshots going back three years. |
| OpenSearch | 9 | Sized for a launch that came in at a third of the forecast. |
| Everything else | 18 | Load balancers with no targets, idle Elastic IPs, a few forgotten SageMaker notebooks. |
| **Total** | **236** | |

None of these is a bad architecture decision. They are missing feedback loops. The fix was partly technical and partly about who sees what.

## Requirements

Before touching anything we wrote down what "done" meant, so cost work couldn't quietly trade away reliability.

**Business and functional**

- **R1. Every dollar has an owner.** At least 95% of monthly spend attributed to a team and a product through tags or cost categories.
- **R2. Unit cost goes down.** Cost per active customer down at least 40% from the July peak within two quarters.
- **R3. Surprises are caught in days, not at month end.** Any spend anomaly over $500 a day reaches the owning team within 24 hours.
- **R4. Carbon is measured.** Estimated emissions tracked per month alongside the bill, with a proxy KPI the teams can see daily.

**Non-functional and constraints**

- **N1. SLOs don't move.** 99.9% monthly availability and p95 API latency under 300 ms, measured before and after each change.
- **N2. Still three AZs.** No cost cut is allowed to remove a zone of redundancy or a backup.
- **N3. No rewrite.** Same services, same data model. Changes are configuration, instance choice, pricing model and housekeeping.
- **N4. Commitments stay flexible.** One-year terms only while the architecture is still moving, and commitment utilization above 95%.
- **N5. Small team.** Four platform engineers, so anything manual has to become a default or a policy.

## Step 1: see the bill the way the teams see their systems

You can't ask teams to own costs they can't see. The first two weeks went entirely on visibility, and it paid for itself before a single instance changed.

**Tags, enforced at creation.** Four tags on everything: `team`, `service`, `env` and `cost-center`. A **tag policy** in AWS Organizations defines the allowed keys and values, so `Team`, `team` and `TEAM` don't become three owners. Tag policies standardize values but don't force a tag to exist, so an **SCP** denies `ec2:RunInstances`, `rds:CreateDBInstance` and friends when `aws:RequestTag/team` is missing. Infrastructure as code sets the tags from one place; I covered that in [Terraform on AWS for enterprises](/blog/terraform-aws-enterprise-guide/).

**Activate them as cost allocation tags.** Tags don't appear in Cost Explorer or the cost and usage report until you activate them in the Billing console of the management account. You can ask for a backfill of up to 12 months when you activate, which is how we got a before-and-after view on day one.

**Cost Categories for what tags can't do.** Shared things, such as the EKS control plane, NAT gateways and the payer account's support plan, get split across teams by rules in a cost category. Untagged spend gets its own visible category called "nobody". It went from 31% of the bill to 3%.

**CUR 2.0 through Data Exports, hourly, into S3.** This is the raw bill, one row per resource per hour, as Parquet. We also turned on **split cost allocation data for Amazon EKS**, which allocates each node's cost to the pods on it based on their CPU and memory requests. Without it, a shared cluster is one big unexplained line. With it, the checkout team can see what its pods cost.

**Athena and QuickSight on top.** A Glue crawler keeps the table definition current, Athena queries it, and the open-source Cloud Intelligence Dashboards give a QuickSight dashboard per team without building one from scratch. The FinOps tooling lives in its own account with delegated access to the billing data, so analysts don't need access to the management account.

**Alerts to the owner.** One AWS Budget per team with forecast alerts at 80% and 100%, and **Cost Anomaly Detection** monitors per cost category. Both post through SNS into the owning team's channel. The alert that a NAT gateway's data processing jumped 400% overnight goes to the people who deployed the change, the same day.

The first week of showback alone made two teams delete things they had forgotten about. Visibility is a cost control.

## Step 2: remove the waste

With owners attached to every line, the cheap wins took about three weeks and cut $72k a month. This is hygiene, not architecture, and it's where most of the money usually is.

<figure class="diagram wide"><a href="/assets/diagrams/aws-finops/aws-finops-bill-waterfall.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-finops/aws-finops-bill-waterfall.png" alt="Waterfall chart of the monthly AWS bill in thousands of dollars. Start in October: 118. Peak in July: 236. Then one bar per change in the order they were made: delete orphans, idle resources and gp2, minus 16; non-prod scheduling, minus 14; VPC endpoints and AZ-aware traffic, minus 18; logs moved to the Infrequent Access class with retention and sampling, minus 11; S3 tiering and lifecycle, minus 13; rightsize and consolidate, minus 21; Graviton for EKS, RDS and cache, minus 15; Spot for burst, batch and CI, minus 12; Savings Plans and Reserved Instances, minus 11. Now in November: 105. Hygiene and architecture changes saved 93 thousand a month and pricing levers saved 38 thousand. Cost per active customer was 74 dollars in October, 118 at the July peak and 51 now." width="1500" height="860" loading="lazy"></a><figcaption>Where the $131k a month came from, in the order we did it. The pricing levers come last, after the waste is gone.</figcaption></figure>

**Orphans and gp2 (−$16k).** Unattached EBS volumes, snapshots older than the retention policy, load balancers with no targets, idle Elastic IPs. Trusted Advisor and Cost Optimization Hub list them. Every gp2 volume moved to **gp3**, which is about 20% cheaper per GB and includes a 3,000 IOPS baseline regardless of size, so most volumes could also shrink. The migration is an online `ModifyVolume`, no detach.

**Non-prod off at night (−$14k).** Development and test environments only need to exist when people work. **Instance Scheduler on AWS** stops EC2 and RDS instances outside 07:00-20:00 on weekdays: 65 hours out of 168, so about 61% fewer hours. For EKS, the same schedule scales node pools and deployments to zero. CI-created feature environments now have a time-to-live tag and a Lambda that deletes them after 72 hours.

**Stop paying NAT for AWS traffic (−$18k).** NAT gateways charge for every GB they process. Image pulls from ECR and EMR reading the data lake were going through them. **Gateway VPC endpoints for S3 and DynamoDB** have no charge at all, and interface endpoints for ECR, STS and CloudWatch Logs cost a fraction of what the NAT processing did at this volume. Then cross-AZ traffic: data between Availability Zones is charged in both directions, so Kubernetes services got `trafficDistribution: PreferClose`, which keeps calls in the caller's zone when there's a healthy endpoint there. Three AZs stay; they just stop chattering.

**Logs that someone reads (−$11k).** Debug logging off in prod, sampling on the noisiest access logs, retention of 30 days for application logs and 90 for audit-relevant ones (CloudTrail itself goes to S3 for the long term). Logs that are only searched during incidents moved to the **CloudWatch Logs Infrequent Access** log class, which has half the ingestion price in exchange for fewer features, such as no metric filters or Live Tail.

**S3 lifecycle and tiering (−$13k).** Covered below in storage.

## Step 3: rightsize, then consolidate

Rightsizing is where teams worry about performance, so it was done with data, one service at a time, with the SLOs on the screen.

**Pods first.** On a Kubernetes cluster you don't rightsize nodes, you rightsize pod requests, and the nodes follow. We ran the Vertical Pod Autoscaler in recommendation-only mode for two weeks and set CPU and memory requests to the p95 of real use plus headroom. Memory limits stayed equal to requests; CPU limits went away so pods can burst.

**Then let Karpenter pack the nodes.** With honest requests, Karpenter's consolidation (`consolidationPolicy: WhenEmptyOrUnderutilized`) replaces half-empty nodes with fewer, fuller ones. Average node CPU went from 31% to 58%. PodDisruptionBudgets on every service keep consolidation from taking out more than one replica at a time.

**Databases.** Performance Insights showed the Aurora writer peaking at 22% CPU. It went from r5.4xlarge to r7g.2xlarge, one Graviton generation newer and half the size, with one reader instead of two (still in a different AZ, so failover is unchanged). Because I/O was more than a quarter of the Aurora bill, the cluster also moved to **Aurora I/O-Optimized**, which charges nothing for I/O in exchange for higher instance and storage prices. Under about 25%, standard is cheaper; check yours before switching.

**Compute Optimizer every week.** It covers EC2, Auto Scaling groups, EBS, Lambda, ECS on Fargate and RDS, and it flags instances that can move to Graviton. The weekly FinOps review is 30 minutes: the top ten recommendations by dollars from Cost Optimization Hub, an owner for each, done or rejected with a reason.

Rightsizing and consolidation saved $21k. N1 held: p95 latency moved from 212 ms to 219 ms, inside the noise.

## Step 4: Graviton as the default

AWS Graviton processors are AWS's own Arm-based chips. AWS quotes up to 40% better price performance than comparable x86 instances, and up to 60% less energy for the same performance. In our case the like-for-like instance price was about 20% lower, and most services needed fewer instances on top of that.

<figure class="diagram wide"><a href="/assets/diagrams/aws-finops/aws-finops-optimised-workload.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-finops/aws-finops-optimised-workload.png" alt="The same workload after the FinOps changes, inside one Region with a VPC across three Availability Zones. An EKS cluster with nodes launched by Karpenter has three node pools: a baseline pool of on-demand arm64 m7g and c7g instances covered by Compute Savings Plans; a burst pool on Spot with more than 15 instance types, arm64 first and x86 as fallback; and a batch and CI pool on Spot only, scaling to zero with checkpointed jobs. Notes: Graviton for 70% of node hours, Spot for 35%, consolidation lifts CPU use from 31% to 58%; compute down from 92 to 34 thousand dollars a month. Every node pool must prefer arm64 and allow at least 10 instance types. The data tier has Aurora PostgreSQL on r7g.2xlarge, down from r5.4xlarge, I/O-Optimized with one reader, and ElastiCache Valkey on r7g one size down; database spend down from 34 to 17 thousand. A NAT gateway is used only for real internet egress, while gateway endpoints for S3 and DynamoDB and interface endpoints for ECR, STS and Logs carry AWS traffic; data transfer down from 27 to 9 thousand. Topology-aware routing keeps service calls in one AZ where possible. Regional services: an S3 data lake with Intelligent-Tiering by default, a lifecycle rule moving raw data to Glacier Deep Archive at 180 days, CloudWatch Logs on the Infrequent Access class with 30 and 90 day retention, and EBS on gp3 with orphans deleted; S3 down from 24 to 11, logs from 18 to 7, EBS from 14 to 6 thousand. Outside the VPC: Instance Scheduler running non-prod 07:00 to 20:00 on weekdays only, 65 of 168 hours; a one-year no-upfront Compute Savings Plan sized to the lowest hour, covering 72% of eligible compute with a utilisation target above 98%; Compute Optimizer producing a weekly rightsizing list; and the Customer Carbon Footprint Tool tracked next to the bill, with the proxy KPI of vCPU-hours per customer down 47%. Total: 236 to 105 thousand dollars a month while traffic kept growing." width="1640" height="980" loading="lazy"></a><figcaption>The same system, the same three AZs, the same SLOs. What changed is instance choice, pricing model and housekeeping.</figcaption></figure>

How the migration actually went:

1. **Multi-arch images.** CI builds every image for `linux/amd64` and `linux/arm64` with `docker buildx` and pushes one manifest list to ECR. Go, Java, Node.js and Python services needed no code changes. Two services had native dependencies pinned to x86 wheels; upgrading them took a day each.
2. **Node pools prefer arm64.** Karpenter node pools allow both architectures with `kubernetes.io/arch` in `[arm64, amd64]`, and a weighted preference for `arm64`. Images that aren't multi-arch yet carry a `nodeSelector` for `amd64` until they are. A pod never lands on an architecture it can't run on, because the image manifest decides.
3. **Canary per service.** Ten percent of replicas on Graviton for two days, compare p95 latency and error rate, then the rest. One service was 8% slower per request on Graviton and stayed on x86; everything else was equal or faster.
4. **Managed services are the easy part.** Aurora, ElastiCache and OpenSearch moved to Graviton instance types (`r7g`, `m7g`) with a normal instance modification during a maintenance window. No code involved.

By the end, 70% of node hours ran on Graviton. The Graviton move saved $15k on top of rightsizing.

## Step 5: Spot for everything that can restart

EC2 Spot Instances use spare EC2 capacity at up to 90% off on-demand. The catch is that AWS can take them back with a two-minute warning. The trick is to only put work on Spot that doesn't care.

**On Spot:** stateless web and API pods (with enough replicas spread across AZs), queue workers, CI runners, EMR task nodes and batch jobs that checkpoint. **Not on Spot:** the few stateful pods, anything with long uninterruptible transactions, and the minimum replicas needed to serve traffic if every Spot node vanished at once.

Three settings make it boring:

- **Diversify.** Each Spot node pool allows at least 10-15 instance types across families, sizes and both architectures. Karpenter uses the price-capacity-optimized allocation strategy, which picks pools that are both cheap and unlikely to be interrupted. One instance type in one AZ is how you get interrupted all at once.
- **Handle the notice.** Karpenter's interruption queue receives the Spot interruption warnings and rebalance recommendations from EventBridge, cordons and drains the node, and starts a replacement before the two minutes are up. Pods get `terminationGracePeriodSeconds` under 90 and handle `SIGTERM` by finishing the current request.
- **Keep an on-demand floor.** The baseline pool is on-demand (and covered by Savings Plans, below), sized to serve normal traffic even with zero Spot capacity.

Interruptions averaged about four a day across the fleet. Nobody noticed. Spot carries 35% of node hours and saved $12k a month.

## Step 6: commit to the floor, last

Savings Plans and Reserved Instances are discounts for committing to a level of spend for one or three years. They are the most powerful lever and the easiest one to get wrong, because a commitment made before the waste is removed locks the waste in.

<figure class="diagram wide"><a href="/assets/diagrams/aws-finops/aws-finops-commitment-layers.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-finops/aws-finops-commitment-layers.png" alt="Stacked bar chart of one week of EKS and EC2 usage in normalised vCPU per hour, in 4-hour buckets from Monday to Sunday. Weekdays peak around 1,040 vCPU in the afternoon and drop to about 520 at night; weekends stay between 480 and 640. The bottom layer up to 460 vCPU, just under the quietest hour of 480, is green and labelled Savings Plan commitment. The next 160 vCPU, up to 620, is orange and labelled on-demand buffer. Everything above 620 is purple and runs on Spot. Side panels: Floor, Savings Plans: runs every hour of the year, 1-year Compute Savings Plan, no upfront, about 28% under on-demand for this mix. Buffer, on-demand: stateful or interruption-sensitive pods and the first minutes of a scale-up. Peaks, Spot: stateless web, workers, CI and batch, 60 to 75% under on-demand, 2-minute notice. Rule of thumb: buy commitments for what you are sure of, review them every quarter, and never commit to waste you have not removed yet. Rightsize first, then commit." width="1500" height="820" loading="lazy"></a><figcaption>Each layer of compute is paid for differently. Commit only to the floor you would run even on the quietest hour.</figcaption></figure>

**Which kind.** A **Compute Savings Plan** applies to EC2 in any family, size, Region and operating system, and to Fargate and Lambda. That flexibility mattered here, because we were moving from x86 to Graviton and changing sizes while we bought. AWS quotes up to 66% off for Compute Savings Plans and up to 72% for **EC2 Instance Savings Plans**, which lock you to an instance family in one Region. For our mix, a one-year no-upfront Compute Savings Plan came out at about 28% under on-demand. Three-year terms and upfront payment go deeper, but N4 said one year while the architecture was still moving.

**Databases are separate.** Savings Plans for compute don't cover RDS, Aurora, ElastiCache or OpenSearch. Those use Reserved Instances, or the newer Database Savings Plans where they cover your engine; compare the current terms for your engines before you buy. We reserved the Aurora writer and reader and the cache nodes after they had been rightsized, never before.

**How much.** Take the hourly usage after the waste is gone and commit to just under the quietest hour of a normal week. Cost Explorer's purchase recommendations, based on 7, 30 or 60 days of history, are a good starting point; check them against your own floor. Then watch two numbers every month: **utilization** (how much of the commitment you actually used, target above 95%) and **coverage** (how much of eligible usage the commitment covered). Low utilization means you over-committed; coverage well under 60-70% with a stable floor means you can buy more. Buy in small tranches every quarter rather than one big purchase, so they expire at different times.

Commitments were bought centrally in the management account and shared across the organization. Teams own usage; the FinOps lead owns commitments. Savings Plans plus RIs saved $11k a month on top of everything else, which sounds small only because everything before it had already shrunk the base.

## Storage tiering

S3 was $24k a month, and most of it was data nobody had read in months.

- **S3 Intelligent-Tiering by default** for the data lake and anything with access patterns nobody can predict. It moves objects to an Infrequent Access tier after 30 days without access and to Archive Instant Access after 90, with no retrieval fees, for a small monthly monitoring fee per object. Objects under 128 KB aren't monitored or moved, so it isn't worth it for buckets of tiny files.
- **Lifecycle rules where you do know the pattern.** Raw ingested files are re-read in the first week and then almost never: they go to **S3 Glacier Deep Archive** at 180 days, the cheapest storage class AWS has, with retrieval in hours. Noncurrent versions expire after 30 days. Incomplete multipart uploads are aborted after 7 days, which on its own freed 60 TB.
- **S3 Storage Lens** at the organization level to find the next bucket worth looking at: the largest buckets without lifecycle rules, and the ones with the most noncurrent bytes.
- **Block storage:** gp3 everywhere, sized to need, as above, and EBS snapshots older than 90 days moved to the snapshot archive tier or deleted.

S3 went from $24k to $11k, and the data didn't go anywhere.

## Sustainability: the second scorecard

The **Customer Carbon Footprint Tool** in the Billing and Cost Management console shows your account's estimated emissions in metric tons of CO2-equivalent, broken down by service and Region, and how they trend over time. The data arrives with a lag, so it's a monthly trend line, not a dashboard you watch during a deploy. We put it in the monthly showback pack next to the bill.

Because the official numbers lag, teams also track proxy metrics they can see every day. The AWS Sustainability pillar recommends this approach: measure the provisioned resources per unit of work. Ours are vCPU-hours per active customer, GB stored per active customer and GB transferred across AZs per day. vCPU-hours per customer fell 47%, and the first months of carbon data after the changes point the same way.

Almost every lever above is also a sustainability lever:

| Change | Cost effect | Sustainability effect |
| --- | --- | --- |
| Rightsizing and consolidation | Fewer instance-hours | Higher utilization means less idle hardware powered on for you |
| Non-prod scheduling | 61% fewer non-prod hours | Hardware not running for you at night and at weekends |
| Graviton | ~20% lower price per instance | AWS quotes up to 60% less energy for the same performance |
| Spot | Up to 90% off | Uses capacity that already exists and would otherwise sit idle |
| Storage tiering and lifecycle | Cheaper bytes, fewer bytes | Colder tiers use denser, lower-power storage; deleted data uses none |
| VPC endpoints, AZ-local traffic | Less data processing and transfer | Less data moving across the network |
| Log retention and sampling | Less ingestion and storage | Less data processed and kept |

Two choices are mostly about carbon rather than cost. The first is the **Region**: when latency and data residency allow, the Sustainability pillar asks you to consider the carbon intensity of the Region's grid and Amazon's renewable energy projects there. The second is **managed services**, which let AWS run shared infrastructure at higher utilization than one team can.

## Mapped to the Well-Architected Framework

| Pillar and question | What we did |
| --- | --- |
| **Cost Optimization, COST 1: cloud financial management** | A FinOps lead, a weekly 30-minute review, monthly showback per team, unit cost (per active customer) as the headline metric. |
| **COST 2 and 3: governance, monitoring usage and cost** | Tag policy plus SCP at the root, cost allocation tags, cost categories, CUR 2.0 with split cost allocation for EKS, budgets and anomaly detection per team. |
| **COST 4: decommissioning resources** | Orphan cleanup, time-to-live tags on feature environments, lifecycle rules on S3 and snapshots. |
| **COST 6: right type, size and number** | VPA recommendations for pod requests, Karpenter consolidation, Compute Optimizer weekly, Graviton by default. |
| **COST 7: pricing models** | Spot for interruptible work, on-demand buffer, Compute Savings Plans and RIs on the floor. |
| **COST 8: data transfer** | Gateway and interface endpoints instead of NAT, AZ-local service traffic. |
| **COST 9: supply and demand** | Scheduling for non-prod, scale to zero for batch and CI pools. |
| **Sustainability, SUS 1: Region selection** | Region chosen on latency and residency first, grid carbon considered for new workloads. |
| **SUS 2: alignment to demand** | Scale with load, scale non-prod to zero, no idle headroom beyond what N2 needs. |
| **SUS 4 and 5: data, hardware and services** | Storage tiering and deletion, Graviton, managed services, Spot. |
| **SUS 6: process and culture** | Proxy KPIs per team, carbon in the monthly showback pack. |
| **Reliability and Performance Efficiency** | Guarded by N1 and N2: three AZs stay, PDBs on every service, Graviton canaries per service, p95 latency checked after every change. |

## Things that bite

- **Committing before cleaning.** A three-year commitment bought in July, at the peak, would have locked in a bill twice the size it needed to be. Rightsize first, commit last, and in tranches.
- **Savings Plans that silently stop applying.** Move a workload from EC2 to something a Compute Savings Plan doesn't cover, such as RDS, and the commitment keeps charging while its utilization drops. Alert on utilization under 95%.
- **Spot without diversity.** One instance type, one AZ, and an interruption takes out a whole service. At least 10 types per pool, and an on-demand floor.
- **Shrinking below what an AZ loss needs.** Consolidation that runs every node at 90% leaves nothing for the day an AZ goes away. Keep the headroom that static stability needs; it's insurance, not waste.
- **Intelligent-Tiering on tiny objects.** Objects under 128 KB aren't tiered, and lifecycle transitions are charged per object. For millions of small files, compact them first.
- **Chargeback too early.** Billing teams for costs they couldn't see last month makes them argue about the allocation rules instead of fixing anything. Six months of showback, then decide.
- **Cutting what customers notice.** Every change here was measured against N1. A saving that costs an SLO isn't a saving.

## The cadence that keeps it down

The bill doubled because there was no loop. Now there is one:

| When | What | Who |
| --- | --- | --- |
| Daily | Anomaly alerts in team channels. Proxy KPIs on team dashboards. | Owning team |
| Weekly | 30-minute review of the top 10 recommendations by dollars. Owner and decision for each. | FinOps lead + team leads |
| Monthly | Showback per team: cost, unit cost, untagged share, carbon trend. Savings Plan utilization and coverage. | Engineering managers + finance |
| Quarterly | Buy the next commitment tranche. Revisit Region and architecture choices. Run a Well-Architected review on the Cost and Sustainability pillars. | FinOps lead + architects |

Four months in, the bill is $105k for 2,050 customers, $51 per customer. That is 57% less per customer than at the peak, and 31% less than before the growth started. The SLOs didn't move, and the next bill that starts to creep will be in someone's channel the day it happens.

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change them to fit your own system.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-finops/aws-cost-optimization-sustainability-finops.drawio)
- [FinOps control plane (HLD)](/assets/diagrams/aws-finops/aws-finops-hld.drawio)
- [The optimised workload](/assets/diagrams/aws-finops/aws-finops-optimised-workload.drawio)
- [Paying for compute in layers](/assets/diagrams/aws-finops/aws-finops-commitment-layers.drawio)
- [The bill waterfall](/assets/diagrams/aws-finops/aws-finops-bill-waterfall.drawio)

The company, its bill and every number in this article are an illustrative scenario built from patterns I see often. Discounts depend on Region, instance family, term and payment option. Use the AWS Pricing Calculator and your own cost and usage report before you commit to anything.

## References

- [AWS Well-Architected Framework: Cost Optimization pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
- [AWS Well-Architected Framework: Sustainability pillar](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html)
- [AWS Data Exports (CUR 2.0 and FOCUS)](https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html)
- [Using cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html)
- [Tag policies in AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_tag-policies.html)
- [Split cost allocation data](https://docs.aws.amazon.com/cur/latest/userguide/split-cost-allocation-data.html)
- [What are Savings Plans?](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html)
- [Amazon EC2 Spot Instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances.html)
- [AWS Compute Optimizer](https://docs.aws.amazon.com/compute-optimizer/latest/ug/what-is-compute-optimizer.html)
- [AWS Graviton Processor](https://aws.amazon.com/ec2/graviton/)
- [Amazon S3 Intelligent-Tiering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering.html)
- [Instance Scheduler on AWS](https://aws.amazon.com/solutions/implementations/instance-scheduler-on-aws/)
- [AWS Customer Carbon Footprint Tool](https://aws.amazon.com/aws-cost-management/aws-customer-carbon-footprint-tool/)
