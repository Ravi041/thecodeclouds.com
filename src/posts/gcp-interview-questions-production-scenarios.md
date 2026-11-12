---
title: "Google Cloud interview questions: 12 production scenarios and how to answer them"
description: "Scenario-based Google Cloud interview questions for DevOps, SRE and platform roles: Cloud NAT port exhaustion, a leaked service account key, a BigQuery bill spike, 502s on the load balancer and more. For each one, what the interviewer is testing and what a strong answer sounds like."
date: 2026-11-16T04:00:00Z
category: DevOps Interview Questions
coverLabel: "Production broke.\nWhat do you\ndo first?"
coverCode: "Google Cloud · 12 real scenarios"
coverLogos: "google-cloud"
coverImage: /assets/images/covers/gcp-interview-questions-production-scenarios.jpg
coverImageAlt: "DevOps Interview Questions cover reading 'Production broke. What do you do first?', with the Google Cloud logo."
---
Most Google Cloud interview prep is a list of definitions. What is a VPC, what is IAM, what's the difference between Cloud Run and GKE. Those questions still come up, but for any DevOps, SRE or platform role above junior level they're the warm-up. The part of the interview that decides the offer usually starts with "Okay, so imagine it's 2 a.m. and...".

I've sat on both sides of those conversations. The candidates who do well aren't the ones who know the most service names. They're the ones who stay calm, ask one or two good questions, reach for evidence before they reach for a fix, and can say what they'd change so it doesn't happen again.

This is the first article in a new series on this blog, **DevOps Interview Questions**, built around exactly that kind of question. Each scenario below has three parts:

- **The scenario**, the way an interviewer would actually put it.
- **What they're testing**, because the question is almost never about the thing it seems to be about.
- **A strong answer**, written the way you'd say it out loud, with the commands and settings that show you've done it for real.

Don't memorise the answers. Use them to check that your own reasoning lands in the same places.

## How to answer any scenario question

Before the scenarios, one habit that makes every answer better. Structure it in four beats:

1. **Stabilise.** What do you do in the next five minutes to stop the damage? This is often a rollback, a scale-up, or disabling something.
2. **Find evidence.** Which logs, metrics or console pages do you open, and what are you looking for?
3. **Fix the cause.** The real change, not the workaround.
4. **Prevent it.** The alert, policy or design change that means you never get paged for this again.

Interviewers notice when you skip step 2 and jump to a fix you guessed. They also notice when you stop at step 3. Step 4 is where seniority shows.

## 1. Pods can reach Google APIs but calls to a partner API keep timing out

> "Our GKE cluster is private, and egress goes through Cloud NAT. After a traffic spike this morning, calls to a third-party payments API started timing out intermittently. Internal traffic is fine. What's going on?"

**What they're testing:** whether you know how Cloud NAT allocates ports, and whether you'll look at NAT logs and metrics instead of blaming the partner.

**A strong answer:**

"Intermittent timeouts to one external destination right after a traffic spike, with everything internal fine, makes me think of NAT port exhaustion first. Cloud NAT gives each VM a fixed number of source ports per destination IP and port. The default minimum is 64. If a node runs lots of pods that all open connections to the same partner endpoint, that node can run out, and new connections get dropped.

To confirm it, I'd turn on NAT logging if it isn't on and look for entries with `allocation_status: DROPPED`. I'd also check the `nat/dropped_sent_packets_count` metric with the reason `OUT_OF_RESOURCES`. And I'd run:

```
gcloud compute routers get-nat-mapping-info ROUTER --region=REGION
```

to see how many ports each node actually has.

For the fix, I'd enable dynamic port allocation so busy nodes can borrow more ports:

```
gcloud compute routers nats update NAT --router=ROUTER --region=REGION \
  --enable-dynamic-port-allocation --min-ports-per-vm=128 --max-ports-per-vm=4096
```

and add NAT IP addresses if the total pool is the limit. Separately, I'd make sure Private Google Access is on for the node subnets, so calls to Google APIs don't burn NAT ports at all. On the app side, connection pooling and keep-alive to the partner cut the number of new connections a lot.

To prevent it, I'd put an alert on dropped NAT packets and on port usage per VM, because this one always comes back with the next traffic record."

## 2. A service account key just showed up in a public GitHub repo

> "Security pings you: a JSON key for a production service account was pushed to a public repository forty minutes ago. Walk me through the next hour."

**What they're testing:** incident discipline. Contain first, investigate with audit logs, and then fix the reason keys exist in the first place.

**A strong answer:**

"First I contain it. I'd disable the key straight away, which stops it working but keeps the record of it:

```
gcloud iam service-accounts keys disable KEY_ID --iam-account=SA_EMAIL
```

I'd delete it once I'm sure nothing legitimate depends on it. I'd also get the commit removed from the repo, but I'd assume the key has already been copied, because bots scrape public GitHub within minutes.

Then I work out what it was used for. In Cloud Logging, I'd search the audit logs for that key:

```
protoPayload.authenticationInfo.serviceAccountKeyName:"KEY_ID"
```

across every project the service account has access to, starting from when it was pushed. I'm looking for calls from IP addresses that aren't ours, new service accounts or keys created, IAM policy changes, and new compute resources, which is the classic crypto-mining pattern. Data Access logs matter here too, if they're on for the sensitive services, because reads of Cloud Storage or BigQuery data won't appear in Admin Activity logs.

If I find anything, it becomes a full incident: revoke whatever the attacker created, rotate any secrets the service account could read, and involve whoever owns data protection.

The real fix is that this service account shouldn't have had a downloadable key. If the key was for CI, I'd move that pipeline to Workload Identity Federation so it gets short-lived tokens. Then I'd set the `iam.disableServiceAccountKeyCreation` organisation policy so nobody can create new keys without an explicit exception, and add secret scanning to the repos."

## 3. The BigQuery bill jumped five times overnight

> "Finance flags that yesterday's Google Cloud bill was five times the normal day, almost all of it BigQuery. Nobody deployed anything. How do you find out what happened, and how do you stop it happening again?"

**What they're testing:** cost forensics, whether you know where the evidence lives, and whether you know budgets don't stop spending.

**A strong answer:**

"I'd start from the billing export in BigQuery, if we have it enabled, and group yesterday's cost by project and SKU to see whether it's analysis (query) cost, storage or streaming inserts. A sudden jump with no deploy is almost always query cost on on-demand pricing.

Then I'd find the jobs. `INFORMATION_SCHEMA.JOBS` shows every query with who ran it and how many bytes were billed:

```sql
SELECT user_email, job_id, total_bytes_billed / POW(1024, 4) AS tib_billed, query
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)
ORDER BY total_bytes_billed DESC
LIMIT 20;
```

The usual culprits are a scheduled query or a dashboard that refreshes every few minutes and does a `SELECT *` over an unpartitioned table, or a new service account running something in a loop.

To fix the query itself: partition the big tables by date, cluster on the columns people filter on, and turn on `require_partition_filter` so a query without a date filter fails instead of scanning everything.

To stop it at the platform level, I'd set custom quotas on query usage per day, per project and per user. That's a real cap. A billing budget is not. Budgets send alerts, and you can wire them to Pub/Sub to trigger automation, but on their own they don't stop anything. For steady heavy workloads I'd also look at whether capacity-based pricing with reservations makes the cost predictable."

## 4. Cloud Run is fast all day, then slow first thing every morning

> "Users say our Cloud Run API is snappy during the day but the first requests every morning take four or five seconds. The p50 latency looks fine. What do you check?"

**What they're testing:** whether you understand scale to zero, cold starts, and the settings that trade money for latency.

**A strong answer:**

"That pattern is classic cold starts. Overnight traffic drops, Cloud Run scales the service to zero, and the first requests in the morning wait for a new instance to start the container and run the app's startup code.

I'd confirm it in Cloud Logging: cold starts show up as request latency that includes container startup, and I can line those slow requests up against the instance count metric going from zero to one.

There are two sides to the fix. On the platform side, set a minimum number of instances so there's always one warm, and turn on startup CPU boost so startup gets more CPU:

```
gcloud run services update api --region=REGION --min-instances=1 --cpu-boost
```

Min instances cost money while idle, so I'd size that against the latency target, maybe one instance off-peak.

On the app side, I'd look at what happens at startup. Large images, loading big config or ML models, opening database pools eagerly, or a framework that scans the classpath all add seconds. Lazy-load what you can and make the image smaller.

I'd also check concurrency. If it's set to 1, every burst of traffic needs new instances, which means more cold starts during the day too."

## 5. A GKE node upgrade took down a service

> "GKE auto-upgraded the node pool in the middle of the afternoon and one of our services was down for six minutes. How would you prevent that?"

**What they're testing:** knowing that upgrades are normal and constant on GKE, and that availability comes from your workload settings plus a few cluster controls.

**A strong answer:**

"First, I'd find out why one service went down when the others didn't. Usually it's a deployment with a single replica, or several replicas that all landed on the same node, so draining that one node took everything out.

So the workload fixes come first. Run at least two replicas, spread them across nodes and zones with topology spread constraints, add a PodDisruptionBudget so the drain can't evict them all at once, and make sure readiness probes are honest, so traffic only goes to pods that are really ready. One gotcha: GKE respects a PodDisruptionBudget during node upgrades for up to an hour, then carries on anyway. A PDB that can never be satisfied, like `minAvailable: 1` on a one-replica deployment, doesn't protect you. It just delays the outage.

On the cluster side, I'd set a maintenance window so upgrades happen at a quiet time, and use maintenance exclusions around big events like a launch or Black Friday. Surge upgrade settings control how many nodes are replaced at once. For node pools where that's too risky, blue-green node pool upgrades let you roll back. And I'd pick a release channel on purpose instead of letting it default.

What I wouldn't do is turn off auto-upgrade. Falling behind on versions creates a much bigger, scarier upgrade later."

## 6. The load balancer returns 502s, but the backends look healthy

> "We get a small but steady rate of 502s from our global external Application Load Balancer. The backend pods look healthy and their own logs show no errors. Where do you look?"

**What they're testing:** whether you know the load balancer writes its own logs and tells you exactly why it returned the error.

**A strong answer:**

"The load balancer's request logs are the first stop, because for errors it generated itself, `jsonPayload.statusDetails` says why. A few values I'd expect:

- `failed_to_pick_backend` means no healthy backend was available, so I'd check health checks and the firewall. Health checks come from `130.211.0.0/22` and `35.191.0.0/16`, and they need to be allowed in.
- `backend_timeout` means the backend took longer than the backend service timeout, which is 30 seconds by default.
- `backend_connection_closed_before_data_sent_to_client` usually means the backend closed an idle connection that the load balancer was about to reuse.

That last one fits 'steady trickle of 502s with no errors in the app'. The load balancer keeps connections to backends open for around ten minutes. If the web server's keep-alive timeout is shorter, say the 5 seconds a lot of Node.js and nginx defaults use, it closes the connection just as the load balancer sends a request on it. The fix is to set the backend's keep-alive timeout longer than the load balancer's.

If it's `backend_timeout` instead, I'd look for slow endpoints and decide whether the timeout or the endpoint needs to change. And if I'm on GKE with container-native load balancing, I'd check that pods shut down gracefully. They need a preStop delay so the load balancer stops sending traffic before the container exits, otherwise every rollout produces a burst of 502s."

## 7. One zone has a problem. What happens to us?

> "Google reports a degradation in one zone of the region you run in. Walk me through what happens to our stack: GKE, Cloud SQL, and some Compute Engine VMs."

**What they're testing:** whether resilience was designed in, and whether you know the difference between zonal and regional resources.

**A strong answer:**

"It depends on how each piece was built, so I'd answer it piece by piece.

For GKE, a regional cluster has its control plane and nodes spread across three zones. If our pods are spread with topology constraints, we lose a third of capacity and the rest carries on, as long as we've left enough headroom. A zonal cluster is a single point of failure, both for the control plane and the nodes.

For Cloud SQL, an HA instance has a primary and a standby in different zones with synchronous replication. If the primary's zone fails, it fails over automatically, with a short interruption while connections move. Apps need retry logic for that, or they'll throw errors for a while after the failover finishes. A non-HA instance is down until the zone recovers.

For VMs, a regional managed instance group spreads instances across zones and recreates them in healthy zones. A single standalone VM is just down.

So my honest answer in an interview is: tell me which of those we built, and I'll tell you the impact. Then I'd add that zonal failure is the case you design for by default. Regional failure is a different conversation about cross-region replicas, backups in another region, and a tested runbook, and it should be driven by the RTO and RPO the business actually needs."

## 8. Pub/Sub messages are being processed twice

> "Our order service consumes from a Pub/Sub subscription and some orders are being processed twice. The team thinks Pub/Sub is broken. Is it?"

**What they're testing:** delivery semantics, and whether you design consumers to cope with them.

**A strong answer:**

"Probably not broken. Pub/Sub's default is at-least-once delivery, so duplicates are expected. They get much more frequent when a consumer doesn't ack within the ack deadline, because Pub/Sub then redelivers the message to someone else while the first worker is still processing it.

So I'd check two things. First, processing time against the ack deadline. If processing an order sometimes takes longer than the deadline, either extend it or rely on the client library's lease management, which extends it automatically while the message is in flight. Second, whether the consumer acks after the work is committed or before, and whether errors cause nacks that lead to retries.

The real fix is to make the consumer idempotent. Use the order ID as an idempotency key and record it in the same transaction as the work, so processing the same message twice has no extra effect. That's the only approach that's safe whatever the broker does.

Pub/Sub does offer exactly-once delivery for pull subscriptions, which removes redelivery once a message is acked successfully. But it doesn't make your side effects transactional, so I'd still want idempotency. And I'd add a dead-letter topic so a message that keeps failing doesn't loop forever, plus an alert on `subscription/oldest_unacked_message_age` so we see a stuck consumer before customers do."

## 9. Someone deleted the production bucket's data

> "A cleanup script with the wrong prefix deleted most of the objects in a production Cloud Storage bucket an hour ago. Can we get them back? And how should this have been prevented?"

**What they're testing:** knowing the recovery features, and layering protection rather than trusting people to be careful.

**A strong answer:**

"First, stop the script and any lifecycle rules that might delete more.

Then recovery depends on what's enabled. Soft delete is on by default for buckets with a seven-day retention, unless someone turned it off, so deleted objects can be listed and restored within that window. If object versioning was on, the deleted objects are still there as noncurrent versions and can be restored too. I'd check the bucket's settings, list the soft-deleted or noncurrent objects under that prefix, and restore them in bulk.

If neither was on, we're into backups. That might be a replicated bucket in another region, or the source system regenerating the data.

For prevention, I'd layer it. Keep soft delete on, with a longer retention for important buckets. Use versioning where overwrites are a risk too. For data that must never be deleted early, a retention policy, and possibly a locked one, means nobody can delete objects before they're old enough, not even an admin. Then fix IAM. A cleanup script shouldn't run as an identity that can delete across the whole bucket. It should be scoped to the prefix it owns, or have no delete permission at all and rely on lifecycle rules instead. And for anything destructive, a dry-run mode that prints what it would delete before it deletes anything."

## 10. A developer needs production access, right now

> "An engineer needs to debug a production issue and asks for Owner on the prod project 'just for today'. What do you do?"

**What they're testing:** whether you can be secure without being the person who blocks the fix.

**A strong answer:**

"I wouldn't grant Owner, and I wouldn't say no and walk away either. I'd ask what they actually need to do. Debugging usually means reading logs, looking at GKE workloads, maybe reading from a database. That's a set of narrow roles like Logs Viewer and GKE viewer roles, not Owner, which can change IAM and delete the project.

Then I'd make the access temporary. The cleanest way on Google Cloud is Privileged Access Manager. You set up an entitlement with the right roles and a maximum duration, the engineer requests it with a justification, someone approves it, and it expires automatically. Everything is logged in the audit logs. Without PAM, an IAM condition with an expiry time does the same job:

```
gcloud projects add-iam-policy-binding PROJECT --member=user:ENGINEER \
  --role=roles/logging.viewer \
  --condition='expression=request.time < timestamp("2026-11-16T18:00:00Z"),title=incident-debug'
```

The deeper point is that if engineers routinely need prod access to debug, observability is missing. The logs, traces and dashboards should be available read-only to the team by default, so debugging doesn't need elevated access at all."

## 11. We turned on VPC Service Controls and the data pipeline broke

> "Security added our data projects to a VPC Service Controls perimeter. Now the nightly Dataflow job and a BigQuery export from another project fail with permission errors, even though IAM looks right. How do you sort it out?"

**What they're testing:** whether you understand that VPC Service Controls sit on top of IAM, and that you roll them out in dry-run first.

**A strong answer:**

"With VPC Service Controls, IAM can say yes and the perimeter still says no, because the perimeter blocks API calls that cross its boundary. The error messages normally include a `vpcServiceControlsUniqueId`, and I'd search the audit logs for it. The violation log tells you the service, the method, the identity and which perimeter rule blocked it.

Typical causes are a job in a project outside the perimeter reading data inside it, a service account from another project, or a call coming from an IP outside an allowed access level. The fix is an ingress or egress rule that allows exactly that flow: this identity, from this project, to this service and method. Or I'd move the project into the perimeter if it really belongs there. What I wouldn't do is open the perimeter wide to make the error go away.

For the process, perimeters should go into dry-run mode first. In dry-run, violations are logged but not enforced, so you can run for a week or two, collect everything that would break, write the rules, and only then enforce. I'd suggest we put this perimeter back into dry-run, fix the rules properly, and re-enforce."

## 12. Cloud Run scaled up and the database fell over

> "A marketing email went out, Cloud Run scaled from 5 to 200 instances, and Cloud SQL started refusing connections. The site was down for twenty minutes. What happened, and what's the fix?"

**What they're testing:** whether you see the whole system. Autoscaling one tier can take down the tier behind it.

**A strong answer:**

"The maths is the problem. If each Cloud Run instance opens a connection pool of, say, 10 connections, 200 instances want 2,000 connections. Cloud SQL has a `max_connections` limit that depends on the machine size and configuration, and once you pass it new connections are refused. The app retries, which makes it worse.

To stabilise during the incident, I'd cap the Cloud Run service's maximum instances to a number the database can handle, which turns errors into some queueing and slower responses. That's a better failure mode.

For the actual fix, I'd size it together. Max instances times pool size per instance has to stay under the database's connection limit, with headroom for migrations and admin. I'd set max instances deliberately, keep the pool per instance small, and make sure the app uses the pool properly and isn't opening a connection per request. If we genuinely need that many app instances, a connection pooler in front of Postgres helps, and read replicas take read traffic off the primary.

Then prevention. Load test before big campaigns, alert on database connection count and CPU, and ask whether some of that traffic could be cached or served statically. A marketing email shouldn't be able to take down checkout."

## A few questions to ask back

Strong candidates ask questions in scenario interviews, and interviewers like it. It's how real incidents start. A few that fit almost any of these:

- "Is this one service or everything?" Scope changes the whole investigation.
- "What changed recently?" Deploys, config changes, traffic patterns, Google Cloud status.
- "What does the business need here?" RTO, RPO and cost limits decide between a cheap fix and a robust one.
- "Do we have logs and metrics for this already?" If the answer is no, adding them is part of your answer.

## What's next in the series

This series will keep going with one set of real-world scenarios at a time: Kubernetes troubleshooting, AWS, Terraform, CI/CD and incident response are next on the list. If there's a scenario you were asked in an interview and weren't happy with your answer, send it my way and I'll write it up.

If you're preparing for a Google Cloud networking round in particular, the [AWS and Google Cloud multi-cloud networking walkthrough](/blog/aws-gcp-multicloud-networking/) covers the design questions that tend to come after the troubleshooting ones.
