---
title: "Disaster recovery on AWS compared: backup and restore, pilot light, warm standby and active/active"
description: "How to pick a disaster recovery strategy on AWS by RTO, RPO and cost: AWS Backup with air-gapped vaults, pilot light with AWS Elastic Disaster Recovery, warm standby with ARC Region switch, and when active/active is worth it. Real numbers for a four-tier portfolio, five incident scenarios, a game-day plan and four editable draw.io diagrams."
date: 2026-11-21T03:15:00Z
category: Cloud & DevOps
coverLabel: "Four ways\nto survive\na bad day."
coverCode: "RTO · RPO · $  →  pick per tier"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-disaster-recovery-strategies-compared.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Four ways to survive a bad day.', with the AWS logo."
---
Every company I've worked with had a disaster recovery plan. Fewer had one that worked. The usual story goes like this: someone wrote a DR document for an audit, it said "RTO 4 hours", nobody tested it, and on the day it was needed the backups were in the same account the attacker had just emptied, or the recovery Region had a vCPU quota of 64, or the only person who knew the order of the steps was on a plane.

AWS gives you four well-known disaster recovery strategies: **backup and restore**, **pilot light**, **warm standby** and **multi-site active/active**. They sit on a line. The more you keep running in the recovery Region, the faster you recover and the less data you lose, and the more you pay every month for something you hope never to use.

This article compares the four on the three things that matter: how fast you're back (RTO), how much data you lose (RPO), and what it costs. It uses one fictional company with four kinds of application, puts real numbers on each strategy, and maps the whole design to the AWS Well-Architected Framework. There are four diagrams, each an editable `.drawio` file built with the official AWS shapes that ship with draw.io, and five incident scenarios at the end, written as timelines.

## The short version

- **Pick a strategy per application tier, not per company.** A payments API and an internal wiki should not share a DR design or a DR budget.
- **Backup and restore** (RTO hours, RPO hours) is the floor for everything. With AWS Backup, a cross-Region copy and a logically air-gapped vault, it is also your only real defence against ransomware and bad deploys.
- **Pilot light** (RTO tens of minutes, RPO seconds) keeps data live and compute off. For server fleets, **AWS Elastic Disaster Recovery** does this for about $0.028 per server per hour plus storage.
- **Warm standby** (RTO minutes, RPO seconds) runs a small working copy of the whole stack. **ARC Region switch** turns the failover into a plan you can run and time.
- **Active/active** (RTO and RPO near zero) costs at least double and changes how you write the application. Use it only where minutes of downtime cost more than the second Region.
- **Replication is not backup.** Replication copies a dropped table to the other Region in under a second. Keep point-in-time backups for every strategy.
- **An untested plan has an unknown RTO.** Run a game day every quarter with AWS Fault Injection Service and write down what you measured.

## RTO, RPO, and what a "disaster" actually is

Two numbers drive every DR decision, and they come from the business, not from engineering.

- **RTO (recovery time objective)** is the longest the application can be down before the damage is unacceptable. It's measured from when the service broke, not from when someone noticed.
- **RPO (recovery point objective)** is how much data you can afford to lose, measured in time. An RPO of 5 seconds means losing the last 5 seconds of orders is acceptable. Losing a minute is not.

It also helps to be specific about what you're recovering from. In the AWS DR whitepaper's terms, high availability inside a Region (several Availability Zones, Auto Scaling, Multi-AZ databases) handles the common failures. Disaster recovery covers the rare and large ones:

| Event | Example | What saves you |
|---|---|---|
| Regional impairment | A service you depend on degrades across a whole Region for hours | A second Region: pilot light, warm standby or active/active |
| Site loss outside AWS | A flood, fire or power loss at your own data center | Elastic Disaster Recovery into an AWS Region |
| Data corruption | A migration drops a column; a bug overwrites balances | Point-in-time backups. Replication makes this worse |
| Malicious action | Ransomware, or an attacker deleting resources with stolen admin keys | Immutable backups in a separate account, a clean account to restore into |

The last two rows are the ones teams forget. A warm standby in a second Region does nothing for you if a bad deploy corrupts the primary database, because Aurora Global Database will faithfully replicate the corruption in about a second. So every tier in this article gets backups, and the more expensive strategies sit on top of them, not instead of them.

## Requirements: a four-tier portfolio

The example is a regional insurer with about 600 employees and 300,000 policyholders. It runs a mix of cloud-native and lifted-and-shifted applications on AWS plus a data center that is still open. The risk and compliance team signed off these requirements:

**Business and compliance requirements**

1. Every application has an agreed tier with a written RTO and RPO (table below).
2. A ransomware event must be recoverable without trusting any credential in the production accounts. Backups must be immutable for at least 90 days.
3. The regulator wants evidence of a DR test for every tier 0 and tier 1 application each year. The company wants it every quarter.
4. Recovery Regions stay in the same country as the primary for data residency.
5. Total DR running cost must stay under 25% of the production run rate across the portfolio.

**Technical requirements**

1. Recovery must not depend on control-plane operations in the impaired Region (no "edit the DNS record in a panic" steps).
2. Infrastructure is defined as code and deployed to both Regions by the same pipeline.
3. Failover is a runbook a tired on-call engineer can run at 3 a.m., with a human approval at the start.
4. Failback is planned and tested too, not left for later.

| Tier | Applications | RTO | RPO | Strategy | DR running cost |
|---|---|---|---|---|---|
| 0 | Payments and quote API | ~0 | ~0 | Multi-site active/active | ~100% of prod |
| 1 | Customer claims portal | 15 min | 5 s | Warm standby | ~40% of prod |
| 2 | Policy admin back office (40 on-premises servers) | 1 h | 1 min | Pilot light with Elastic Disaster Recovery | ~$2,000/mo |
| 3 | Document archive, reporting, internal tools | 4 h | 1 h | Backup and restore | ~5% of prod |

The tier 0 design (writes in two Regions, conflict handling, global tables) is a large topic on its own and has its own article in this series, so it gets only a short section here. Everything else is below.

## The four strategies side by side

<figure class="diagram wide"><a href="/assets/diagrams/aws-dr-strategies/aws-dr-spectrum.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-dr-strategies/aws-dr-spectrum.svg" alt="Four columns, one per disaster recovery strategy, each with a primary Region running Route 53, an Application Load Balancer, an Auto Scaling group and Aurora, and a recovery Region below it. Backup and restore: the recovery Region holds only an AWS Backup vault with cross-Region copies and an S3 replica; CloudFormation templates and the Aurora cluster are defined but not running. RPO hours, RTO hours, about 5% of production cost. Pilot light: an Aurora secondary cluster is live and receiving replication; the Auto Scaling group is at zero and the load balancer has no targets. RPO seconds to minutes, RTO tens of minutes, about 10 to 20% of production cost. Warm standby: Aurora secondary with a reader, Auto Scaling at 25% capacity serving canaries, ALB live. RPO seconds, RTO minutes, about 30 to 50% of production cost. Multi-site active/active: DynamoDB global tables accept writes in both Regions, Auto Scaling at 100%, both ALBs serve users. RPO and RTO near zero, 100% or more of production cost." width="1500" height="840" loading="lazy"></a><figcaption>The same application under each strategy. Grey icons are defined but not running. The cost bars are the running cost of the recovery Region for the example workload.</figcaption></figure>

Here is how they compare on the numbers, using the tier 1 claims portal as the example workload. In production it runs 12 `m7g.xlarge` instances behind an ALB, an Aurora PostgreSQL cluster with a `db.r7g.2xlarge` writer and one reader, 2 TB of data, and an ElastiCache cluster for sessions. That is roughly **$4,100 a month** in us-east-1 at on-demand list prices.

| | Backup and restore | Pilot light | Warm standby | Active/active |
|---|---|---|---|---|
| What runs in the recovery Region | Nothing. Backups and templates only | Data stores; compute off | Whole stack, scaled down | Whole stack, full size |
| Typical RPO | Hours (backup interval) | Seconds to minutes | Seconds | Zero to seconds |
| Typical RTO | Hours | Tens of minutes | Minutes | Near zero |
| Recovery Region cost for the example | ~$200/mo | ~$500/mo | ~$1,700/mo | ~$4,200/mo and up |
| Share of production | ~5% | ~12% | ~40% | 100%+ |
| Biggest risk on the day | Restore takes longer than you thought | No capacity to scale into | Config drift between Regions | Data conflicts, complexity |
| Needs application changes | No | Small | Small | Yes |

The cost figures are rounded on-demand list prices for us-east-1 and us-west-2 in November 2026, before Savings Plans or Reserved Instances. They are there to show the ratio, not to quote. Run your own numbers in the AWS Pricing Calculator.

Two things in this table surprise people. First, the gap between pilot light and warm standby is mostly the database reader, not the app servers: a full-size Aurora reader costs more than three small instances. Second, active/active is usually more than 100%, because cross-Region data transfer and the extra engineering are real costs that don't show up as instances.

## Backup and restore: the floor under everything

Backup and restore means nothing runs in the recovery Region. You keep copies of your data there and you keep your infrastructure as code, and when disaster strikes you deploy the stack and restore the data. It's the cheapest strategy, and it's the one you need even when you have the others, because it is the only one that protects you from corruption and deletion.

<figure class="diagram wide"><a href="/assets/diagrams/aws-dr-strategies/aws-dr-backup-restore.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-dr-strategies/aws-dr-backup-restore.svg" alt="An AWS Organizations backup policy applies to the production OU. In the workload account in us-east-1, EC2 with EBS, Aurora PostgreSQL with continuous backup, DynamoDB with point-in-time recovery and S3 with versioning feed a tier-1 backup plan, which writes hourly and daily recovery points into a local backup vault encrypted with a KMS key in that account. The vault copies to a dr-copy vault in us-west-2 encrypted with a multi-Region KMS key, and to a logically air-gapped vault in a separate backup account, locked in compliance mode with 90-day retention. The air-gapped vault is shared through AWS RAM with a clean-room recovery account, where the stack is rebuilt from code. CloudFormation or Terraform templates and weekly restore testing complete the picture. A timeline shows a 2 TB, 25 instance restore reaching RTO in 2 hours 30 minutes against a 4 hour target, with a 1 hour RPO." width="1500" height="870" loading="lazy"></a><figcaption>One backup policy, three copies: local for speed, cross-Region for a Region outage, air-gapped in another account for ransomware.</figcaption></figure>

The building blocks on AWS:

- **AWS Backup plans, applied by an AWS Organizations backup policy.** Attach the policy to the production OU and select resources by tag (`backup:tier=1`). New databases get backed up because someone tagged them, not because someone remembered to edit a plan.
- **Continuous backup where it exists.** AWS Backup supports continuous backup with point-in-time restore for Aurora, RDS and S3, and DynamoDB has its own point-in-time recovery. That gets RPO down to minutes for the data stores without waiting for the next snapshot.
- **A cross-Region copy rule** to a vault in the recovery Region, encrypted with a key that exists there. AWS KMS multi-Region keys make this simpler, because the same key material is usable in both Regions.
- **A logically air-gapped vault in a separate backup account.** It is always locked with vault lock in compliance mode, so nobody can delete recovery points before their retention ends, including the account root user. You can share it with another account through AWS RAM and restore from there, which is what makes the "clean room" recovery account possible. It uses an AWS owned key by default, or a customer managed key you choose at creation.
- **Restore testing.** AWS Backup can restore a sample of recovery points on a schedule and run your validation (a Lambda function that checks row counts, for example), then delete the test resources. This is how you turn "we have backups" into "we restored last Tuesday and it took 41 minutes".

The RTO for backup and restore is bound by data size, not by how quickly you click. Restoring a 2 TB Aurora cluster from a snapshot takes a meaningful amount of time, and a hundred EBS volumes restore in parallel but still need to warm up. Measure it. In the example timeline, deploying the network and IAM takes 10 minutes, the Aurora restore takes about 80, and the app is serving traffic 2 hours 30 minutes after the call is made. That fits the tier 3 target of 4 hours with room to spare, and it is nowhere near good enough for the claims portal.

## Pilot light: data live, compute off

Pilot light keeps the data layer running in the recovery Region and everything else switched off. On the day, you promote the database, scale compute from zero to full size, and switch traffic. RPO drops to seconds because data replicates continuously. RTO drops to tens of minutes because you're no longer restoring data, just starting servers.

For a cloud-native application, pilot light looks like this:

- An **Aurora Global Database** secondary cluster in the recovery Region. It can run headless (storage only, no instances) or with one small instance, and you add instances when you fail over.
- **DynamoDB global table** replicas and **S3 replication** with Replication Time Control if you need a predictable replication window.
- **AMIs and container images replicated** to the recovery Region, Auto Scaling groups and EKS node groups defined at zero, Lambda functions deployed.
- **Service quotas raised and capacity planned** for the size you'll scale to. The slowest step in a pilot-light recovery is usually waiting for capacity, not the database.

For a fleet of servers that weren't built for the cloud (the insurer's 40 policy admin servers, a mix of Windows, Linux and SQL Server in its own data center), AWS has a managed version of the same idea.

<figure class="diagram wide"><a href="/assets/diagrams/aws-dr-strategies/aws-dr-pilot-light-drs.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-dr-strategies/aws-dr-pilot-light-drs.svg" alt="On-premises source servers (24 Windows app servers, 12 Linux app servers and 4 SQL Server hosts with 2 TB of data) run the AWS Replication Agent, which sends block-level, compressed, encrypted data over TCP 1500 to replication servers in a staging subnet in us-east-2. The replication servers write to staging EBS volumes, one per source disk, and AWS Elastic Disaster Recovery keeps point-in-time snapshots: every 10 minutes for the last hour, then hourly, then daily for 7 days. When needed, recovery or drill instances launch from the latest or any earlier point in time into a recovery subnet using launch templates, behind an ALB and a Route 53 failover record. A dashed failback path replicates changes back to the source. A cost box shows about $1,975 a month for 40 servers and 8 TB, compared with $9,000 to $11,000 for a full running copy. A drill box shows a measured RTO of 36 minutes against a 1 hour target and an RPO under 1 minute." width="1500" height="830" loading="lazy"></a><figcaption>Elastic Disaster Recovery: a cheap staging area replicates all the time, and full-size instances exist only during a drill or a real recovery.</figcaption></figure>

**AWS Elastic Disaster Recovery (DRS)** installs an agent on each source server, replicates its disks continuously at block level into a low-cost staging area in your AWS account, and launches converted, right-sized EC2 instances when you start a drill or a recovery. AWS describes it as giving RPOs of seconds and RTOs of minutes. It keeps point-in-time snapshots, so after ransomware you can launch from a moment before the encryption started, and it supports failback to the original site once it's healthy. The source can be a data center, another cloud, or EC2 in another Region or Availability Zone.

The cost model is what makes it attractive. You pay a flat **$0.028 per source server per hour** (about $20 a month), plus the staging EBS volumes, the snapshots and a few small replication servers (by default `t3.small`, each handling up to 15 disks). For the insurer's 40 servers and 8 TB of disks, that is roughly $818 + $640 + $455 + $61, **about $1,975 a month**, against $9,000 to $11,000 for keeping a full copy of the fleet running. A drill of all 40 servers for 8 hours adds about $45 of EC2.

What DRS doesn't do for you: the network. The recovery VPC, subnets, security groups, DNS, Active Directory, and connectivity for users all have to exist and be tested. In my experience that is where the first drill fails, not in the replication.

## Warm standby: a small copy that already works

Warm standby runs the whole stack in the recovery Region at reduced size. Every component is deployed and healthy, the database is a live replica with a reader, and synthetic canaries exercise it all day. On the day, you scale it up and move traffic. Because everything is already running, the RTO is minutes, and you have far fewer unknowns than with pilot light. That's why the claims portal uses it.

<figure class="diagram wide"><a href="/assets/diagrams/aws-dr-strategies/aws-dr-warm-standby-failover.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-dr-strategies/aws-dr-warm-standby-failover.svg" alt="Customers reach Route 53 failover records, which ARC routing controls flip through a data-plane call. us-east-1 is primary with an ALB, an Auto Scaling group of 12 m7g.xlarge instances, an Aurora PostgreSQL writer and reader, and ElastiCache. us-west-2 is a warm standby with an ALB, 3 m7g.xlarge instances (maximum 16), an Aurora secondary with one reader replicating with lag typically under a second, and an empty ElastiCache. Capacity Reservations cover 9 more instances. An ARC Region switch plan activates us-west-2 in six steps: manual approval at 0:00, scale EC2 Auto Scaling at 0:01, Aurora Global Database failover at 0:03, ARC routing control at 0:08, a post-recovery Lambda function at 0:10, and checks passing at 0:14, against a 15 minute RTO target and 5 second RPO. Below, a quarterly game-day loop runs from an AWS FIS experiment through CloudWatch Synthetics and alarms, the Region switch plan, AWS Resilience Hub assessment and a runbook fix." width="1500" height="900" loading="lazy"></a><figcaption>Warm standby for the claims portal: a quarter of the capacity runs all the time, and a Region switch plan does the rest in about 14 minutes.</figcaption></figure>

The design choices that make it work:

- **Route traffic with data-plane operations.** Route 53 health checks and DNS answers are served by the Route 53 data plane, which is built for very high availability. Changing records is a control-plane operation. ARC routing controls give you on/off switches backed by a highly available cluster that you flip with a data-plane API call, so failover doesn't depend on a console or API in an impaired Region.
- **Script the whole failover as an ARC Region switch plan.** A plan is a set of workflows made of steps, and each step runs execution blocks in sequence or in parallel: scale EC2 Auto Scaling groups, fail over an Aurora global database, flip routing controls, run a Lambda function, wait for a manual approval. Plans support both active/passive and active/active setups, and they record how long each step took, which is exactly the evidence the regulator wants.
- **Pay for the capacity you'll need.** Three instances becoming twelve on a bad day only works if twelve are available. For tier 1, On-Demand Capacity Reservations in the recovery Region for the extra nine instances are cheap insurance. At minimum, raise the service quotas there to production levels.
- **Make the replica useful.** The standby Aurora reader can serve reporting queries, and canaries in the recovery Region prove every dependency (secrets, certificates, third-party APIs, allow-listed IPs) works from there.
- **Keep both Regions identical, apart from size.** Same pipeline, same templates, same parameters, deployed in the same release. Configuration drift is the most common reason a warm standby fails on the day, and AWS calls it out as its own best practice in the Reliability pillar.

## Multi-site active/active, briefly

Active/active runs full production in two or more Regions and serves users from all of them. Recovery is "stop sending traffic to the broken one", so RTO is close to zero, and RPO depends on the data store: zero with Aurora DSQL or DynamoDB global tables using multi-Region strong consistency, a second or so with asynchronous replication.

The cost is not just the second Region. Your application has to cope with writes happening in two places: idempotency keys, conflict rules (DynamoDB global tables default to last writer wins), and careful thought about anything that must be globally unique, such as stock or account balances. That is why the insurer only uses it for the payments and quote API, where five minutes of downtime during a renewal campaign costs more than the second Region does in a year. A separate article in this series covers the full active/active design.

## Testing: the game day

Every strategy above has a theoretical RTO. The real one is whatever you measured last time you tried. AWS's Reliability pillar is blunt about it: test your DR implementation regularly, and automate recovery as much as you can. The insurer runs a game day every quarter for tier 1, in business hours, with the people who are on call that week, not the people who designed the system.

A game day that produces something useful has a fixed shape:

1. **Write a hypothesis with numbers.** "If us-east-1 is unavailable to the claims portal, we restore service in us-west-2 within 15 minutes and lose no more than 5 seconds of data."
2. **Inject the failure with AWS Fault Injection Service.** FIS has scenarios for an Availability Zone power interruption and for cross-Region connectivity loss, and experiment templates can stop automatically on a CloudWatch alarm if real customers start to suffer.
3. **Detect it the way you would on a real day.** CloudWatch Synthetics canaries and composite alarms should page someone. If the first signal came from a person on Slack, that is the first finding.
4. **Run the real plan.** Execute the Region switch plan or the DRS recovery as written. Time every step.
5. **Assess and fix.** AWS Resilience Hub can check the application against an RTO/RPO policy and point out gaps. Every finding becomes a change to code or to the runbook, retested next quarter.

The findings are the point. In the example, the last two game days found that the vCPU quota in us-west-2 was still at its default, that a TLS certificate existed only in us-east-1 (ACM certificates are Regional), and that a nightly batch job ran in both Regions after failover and sent 3,100 duplicate emails. None of these would have shown up in a document review.

## Well-Architected mapping

This design leans most on the Reliability pillar, but every pillar has something to say about DR.

| Pillar | What this design does | Well-Architected guidance |
|---|---|---|
| Reliability | RTO and RPO per tier, a strategy chosen to meet them, quarterly tests, drift control, automated recovery | REL13-BP01 to BP05: define recovery objectives, use defined recovery strategies, test DR, manage configuration drift at the DR site, automate recovery. REL09-BP01 to BP04: back up all data, secure and encrypt backups, back up automatically, restore periodically to verify |
| Security | Air-gapped vault in a separate account, vault lock in compliance mode, KMS keys per Region, a clean-room account to restore into | Protect data at rest; prepare for incident response with isolated recovery environments |
| Operational excellence | Failover as an executable Region switch plan, game days with the on-call team, findings tracked to closure | Use runbooks and playbooks, run game days, learn from operational events |
| Cost optimization | Strategy matched to business impact: the portfolio's DR spend is about 19% of production, under the 25% cap | Spend in proportion to the value of the workload; avoid paying active/active prices for tier 3 |
| Performance efficiency | Capacity Reservations and quotas in the recovery Region, scale-out tested under load | Know your capacity needs and the limits of the services you use |
| Sustainability | Pilot light and DRS keep the recovery footprint to storage and a few small servers instead of idle fleets | Minimise provisioned resources that sit idle |

## Five scenarios from real life

These are composites of incidents I've seen or worked through, with the company names removed and the numbers kept realistic.

### 1. Ransomware in the back office (tier 3)

**What happened.** An attacker phished a contractor, escalated to an administrator role in the document archive account, deleted every EBS snapshot they could see and encrypted 3.2 TB of file shares on a Saturday night.

**What saved it.** The local backup vault had no vault lock, so those recovery points were gone. The copies in the logically air-gapped vault, in a separate backup account the attacker had no path into, were intact. The team shared the vault with a fresh recovery account, deployed the stack from the pipeline, and restored from the last recovery point before the encryption started.

**Numbers.** Detection to declared incident: 50 minutes. Restore and validation: 6 hours 40 minutes. Data lost: 1 hour 10 minutes of edits. The tier 3 RTO of 4 hours was missed, because 3.2 TB of small files took longer to restore than the 400 GB restore test had suggested. The restore test now uses a full-size sample once a quarter.

### 2. A Regional impairment during the claims surge (tier 1)

**What happened.** During a storm, with claims traffic at 1,200 requests per second, a dependency in us-east-1 started failing for a growing share of requests. Error rates on the claims portal rose from 0.2% to 31% in nine minutes.

**What the team did.** The composite alarm paged at 14:02. The incident lead approved the Region switch plan at 14:11, after confirming the impairment wasn't something a rollback would fix. The plan scaled us-west-2 from 3 to 12 instances (Capacity Reservations meant no waiting), failed over the Aurora global database, and flipped the routing controls. Checkout success was above 99% in us-west-2 at 14:25.

**Numbers.** Plan runtime: 14 minutes. Total customer impact: 23 minutes, most of it before the decision. Data lost: about 3 seconds of writes; 41 in-flight claim submissions were retried by clients with the same idempotency key and saved once. Failback happened two days later, in a quiet hour, using the same plan in reverse.

### 3. The data center that lost power (tier 2)

**What happened.** A generator failed to start during a utility outage at the insurer's own data center. The UPS bought 12 minutes, which was enough for a clean shutdown of the SAN and not much else.

**What the team did.** They started a recovery job in Elastic Disaster Recovery for all 40 policy admin servers from the latest point in time, using the launch templates they'd tested in the last drill. The recovery VPC was already connected to the corporate network over Site-to-Site VPN, and DNS for the internal apps was switched with a pre-written change.

**Numbers.** 40 instances launched in 11 minutes; applications healthy at 48 minutes (the target is 1 hour). RPO under one minute. They ran in AWS for nine days and failed back over a weekend. The DR bill for those nine days, including full-size instances, was about $2,600.

### 4. The game day that failed (tier 1)

**What happened.** The first game day for the claims portal ran exactly as written, and the Region switch plan stopped at the scaling step. Auto Scaling in us-west-2 couldn't launch more than 4 instances.

**Why.** The account's On-Demand vCPU quota in us-west-2 had never been raised, because nothing had ever run there at full size. On the same day the team found the TLS certificate issue and the duplicate batch job described earlier.

**Numbers.** Measured RTO at the first game day: 52 minutes, against a 15 minute target. At the next one, after the fixes: 14 minutes. The fixes cost one afternoon each. Finding them during a real storm would have cost hours.

### 5. The bad migration that replicated perfectly (all tiers)

**What happened.** A schema migration on the claims database ran an `UPDATE` without a `WHERE` clause and set the status of 180,000 open claims to "closed". Aurora Global Database copied the change to us-west-2 in under a second.

**Why DR didn't help.** Failing over to the warm standby would have moved the problem to another Region. This is a data recovery problem, not a disaster recovery one.

**What fixed it.** The team restored the cluster to 14:31:50, ten seconds before the migration, into a new cluster using point-in-time recovery, and copied the correct status values back for the affected rows. Total time: 1 hour 35 minutes, with the portal in read-only mode for claims updates. Every strategy needs backups underneath it, which is why every tier has them.

## A practical checklist

- Every application has a tier, an owner, a written RTO and RPO, and a strategy that meets them.
- Every data store is covered by an AWS Backup plan through an Organizations backup policy, with copies in another Region and in a logically air-gapped vault.
- Restore testing runs on a schedule, and the results (time, success) are reported.
- Infrastructure in the recovery Region comes from the same pipeline as production, in the same release.
- KMS keys, secrets, certificates, AMIs, container images and service quotas all exist in the recovery Region.
- Failover uses data-plane operations (health checks, ARC routing controls), not console edits.
- The failover is a Region switch plan or a DRS recovery job, not a wiki page.
- Failback is planned and has been run at least once.
- Game days happen every quarter for tier 0 and tier 1, and every finding becomes a ticket with an owner.
- Scheduled jobs, outbound emails and third-party webhooks are disabled in the standby Region until it becomes primary.

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the Regions, sizes and targets to match your own workloads.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-dr-strategies/aws-dr-strategies-compared.drawio)
- [The four strategies side by side](/assets/diagrams/aws-dr-strategies/aws-dr-spectrum.drawio)
- [Backup and restore with AWS Backup](/assets/diagrams/aws-dr-strategies/aws-dr-backup-restore.drawio)
- [Pilot light with Elastic Disaster Recovery](/assets/diagrams/aws-dr-strategies/aws-dr-pilot-light-drs.drawio)
- [Warm standby, Region switch and game days](/assets/diagrams/aws-dr-strategies/aws-dr-warm-standby-failover.drawio)

The company, instance counts, timings and prices are examples. Check current pricing, quotas and Regional availability for your own Regions before you rely on any of them.

## References

- [Disaster recovery of workloads on AWS: recovery in the cloud (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html)
- [Disaster recovery options in the cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [Reliability pillar: plan for disaster recovery (REL13)](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/plan-for-disaster-recovery-dr.html)
- [Reliability pillar: back up data (REL09)](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/back-up-data.html)
- [AWS Backup developer guide](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html)
- [AWS Backup logically air-gapped vault](https://docs.aws.amazon.com/aws-backup/latest/devguide/logicallyairgappedvault.html)
- [AWS Backup restore testing](https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html)
- [Backup policies in AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_backup.html)
- [AWS Elastic Disaster Recovery user guide](https://docs.aws.amazon.com/drs/latest/userguide/what-is-drs.html)
- [AWS Elastic Disaster Recovery pricing](https://aws.amazon.com/disaster-recovery/pricing/)
- [Amazon Application Recovery Controller: Region switch](https://docs.aws.amazon.com/r53recovery/latest/dg/region-switch-plans.html)
- [Amazon Application Recovery Controller: routing control](https://docs.aws.amazon.com/r53recovery/latest/dg/routing-control.html)
- [Aurora Global Database switchover and failover](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)
- [DynamoDB global tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [AWS Fault Injection Service scenario library](https://docs.aws.amazon.com/fis/latest/userguide/scenario-library.html)
- [AWS Resilience Hub](https://docs.aws.amazon.com/resilience-hub/latest/userguide/what-is.html)
- [On-Demand Capacity Reservations](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html)
