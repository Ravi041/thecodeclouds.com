---
title: "Production-ready e-commerce on AWS: landing zone, WAF, secrets, observability, multi-region DR and cost"
description: "What it takes to run an online shop on AWS that survives Black Friday, a bot attack and a regional outage: a multi-account landing zone, CloudFront with WAF and Shield, Secrets Manager rotation, SLO-based observability, warm-standby DR across two regions and the cost levers that matter. Five real incident scenarios and four editable draw.io diagrams."
date: 2026-11-20T04:06:00Z
category: Cloud & DevOps
coverLabel: "Your shop\non AWS, ready\nfor Black Friday."
coverCode: "RTO 15 min · RPO seconds · p99 < 800 ms"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-production-ecommerce-platform.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Your shop on AWS, ready for Black Friday.', with the AWS logo."
---
Getting an online shop running on AWS takes an afternoon. A container, a database, a load balancer, a domain. Getting it to *production-ready* is a different job, and most of it has nothing to do with the shop itself. It's the account layout that stops a developer from deleting prod. It's the WAF rule that keeps a bot from buying every pair of limited-edition trainers in eleven seconds. It's knowing, at 2 a.m., whether checkout is slow for everyone or just for one payment method. It's having a second region you've actually failed over to, not one that exists on a slide.

This article is the production layer I'd put around an e-commerce platform on AWS today. The example shop does around 40,000 orders on a normal day and about fifteen times that on Black Friday, runs on EKS with Aurora PostgreSQL and DynamoDB, and takes card payments through an external payment provider. The numbers will differ for you. The decisions mostly won't.

There are four diagrams, each an editable `.drawio` file built with the AWS shapes that ship with draw.io. After the design, there are five incidents I've seen versions of in real shops, written as a timeline of what happened and what fixed it.

## The short version

- **Separate accounts, not separate VPCs.** Prod, payments (PCI scope), staging, dev, logs and security tooling each get their own AWS account under AWS Organizations, set up through Control Tower. The account is the only blast-radius boundary AWS guarantees.
- **Put the guardrails on the OU, not on people.** SCPs, RCPs and declarative policies stop things like disabling CloudTrail, using unapproved regions or sharing snapshots publicly, whatever IAM permissions someone has.
- **Nothing in prod is reachable except through CloudFront.** The ALB is internal, reached as a CloudFront VPC origin. AWS WAF and Shield Advanced sit on the distribution.
- **Secrets live in Secrets Manager, rotate on a schedule, and reach pods as files.** Never in environment variables, never in Git, never in a Terraform state you didn't encrypt.
- **Alert on symptoms customers feel.** Checkout success rate and latency against an SLO, measured from the outside by canaries, beat a hundred CPU alarms.
- **Run a warm standby in a second region and practise failing over.** Aurora Global Database, DynamoDB global tables and ARC routing controls get you an RTO of minutes and an RPO of seconds. An untested runbook gets you neither.
- **Cost is a design property.** Graviton, Spot for stateless work, Savings Plans for the baseline, VPC endpoints instead of NAT, and log classes chosen on purpose.

## Landing zone: one account per blast radius

The first thing to get right is where things live. Most shops start in one AWS account, and the day you need to prove to a PCI assessor that your developers can't read card data, or to work out which team's experiment cost $14,000, you find out why that hurts.

<figure class="diagram wide"><a href="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-landing-zone.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-landing-zone.svg" alt="Multi-account landing zone. A management account at the top holds AWS Organizations, Control Tower, IAM Identity Center and Budgets with Cost Anomaly Detection. Below it, four organisational units. Security OU: a Log Archive account with the organisation CloudTrail and an S3 log bucket with Object Lock, receiving CloudTrail, Config, VPC flow, WAF and ALB logs from every account; and an Audit account that is delegated admin for GuardDuty, Security Hub, Inspector, the Config aggregator and Firewall Manager. Infrastructure OU: a Network account with Transit Gateway, Network Firewall for egress allow-listing and Route 53 public zones; and a Shared services and observability account with ECR, Managed Grafana and Prometheus, and CloudWatch cross-account dashboards. Workloads OU: a Prod OU with a shop-prod account (EKS, Aurora, DynamoDB) and a payments-prod account in PCI scope (Secrets Manager, KMS, payments service), and a NonProd OU with shop-staging and shop-dev accounts. A Sandbox OU with per-engineer accounts on a 200 dollar budget, and a Suspended OU with a deny-all SCP. A band at the bottom lists the preventive guardrails: region deny, deny leaving the org or disabling CloudTrail, GuardDuty and Config, deny root user actions and IAM users, require IMDSv2, resource control policies limiting S3, KMS and Secrets Manager to the organisation and requiring TLS, a declarative policy blocking public AMI and snapshot sharing, and a tag policy for CostCentre and Service tags." width="1500" height="930" loading="lazy"></a><figcaption>The landing zone: Control Tower and Organizations, one OU per kind of risk, and guardrails attached to the OU.</figcaption></figure>

### The accounts and why each exists

- **Management account.** Billing, Organizations, Control Tower, IAM Identity Center. Nothing else runs here, because SCPs don't apply to the management account. Anything you put in it is outside your own guardrails.
- **Log Archive.** The organisation CloudTrail, Config history, VPC flow logs, WAF and ALB logs all land in one bucket with S3 Object Lock in compliance mode. Nobody in a workload account can delete the evidence of what they did.
- **Audit (security tooling).** Delegated administrator for GuardDuty, Security Hub, Inspector, the Config aggregator and Firewall Manager. The security team works here and sees every account without needing access to any of them.
- **Network.** Transit Gateway shared out with AWS RAM, centralised egress through Network Firewall, and the public Route 53 zones. The payments service can only reach the payment provider's API hostnames, and that allow-list is in one place.
- **Shared services and observability.** ECR with signed images, Amazon Managed Grafana and the CloudWatch cross-account observability sink.
- **shop-prod and payments-prod.** Splitting payments into its own account is the cheapest PCI DSS decision you'll ever make. Card data is tokenised by the provider, the payments service holds only tokens and its own API keys, and the assessor's scope is one small account instead of the whole platform.
- **shop-staging and shop-dev.** Same Terraform, smaller sizes. Staging is prod-shaped so load tests mean something. Dev runs on Spot and synthetic data.
- **Sandbox.** One account per engineer with a hard budget, no network path to anything, wiped weekly with a tool like aws-nuke. This is where people try things, so they don't try them in dev.

If you are setting up the Terraform for all of this, the [Terraform on AWS enterprise guide](/blog/terraform-aws-enterprise-guide/) covers the state layout and CI roles per account.

### Guardrails that hold even for admins

IAM decides what a role *may* do. Organisation policies decide what *nobody* in that OU can do. The ones I'd attach on day one:

| Policy | Attached to | What it stops |
|---|---|---|
| SCP: region deny | Root (except global services) | Resources in regions you don't run in, which is where crypto-miners go after a leaked key |
| SCP: protect the audit trail | Root | Stopping or deleting CloudTrail, disabling GuardDuty, Config or Security Hub, leaving the organisation |
| SCP: no root, no IAM users | Workloads, Infrastructure | Root user actions and long-lived access keys. Humans use Identity Center, CI uses OIDC roles |
| SCP: IMDSv2 only | Workloads | Launching instances that allow IMDSv1, the old SSRF-to-credentials path |
| RCP: data perimeter | Workloads | S3, KMS and Secrets Manager calls from principals outside your organisation, even if a bucket policy says otherwise |
| Declarative policy for EC2 | Root | Public AMI sharing and public EBS snapshots, enforced by the EC2 service itself |
| Tag policy | Root | Untagged spend. `CostCentre` and `Service` are required, and they become cost allocation tags |

Resource control policies are the newer half of this. An SCP limits what *your* principals can do; an RCP limits what can be done *to your resources*, by anyone. Together they're what AWS calls a data perimeter. If you've ever been confused why an "allow" didn't work, the [explicit deny article](/blog/cloud-iam-explicit-deny/) walks through the evaluation order.

Test SCPs in a staging OU first. A badly written region deny that forgets IAM, CloudFront, Route 53 or Support will break things in ways that look unrelated.

## The request path: edge, cluster, data, secrets

<figure class="diagram wide"><a href="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-request-path.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-request-path.svg" alt="Request path for shop-prod in us-east-1. Shoppers resolve shop.example in Route 53 (step 1), an alias to a CloudFront distribution (step 2). AWS WAF with Bot Control, account takeover prevention and rate-based rules, and Shield Advanced with automatic layer 7 mitigation, are attached to the distribution (step 3); bots and scrapers are challenged or blocked there. CloudFront sends /static to a private S3 bucket through origin access control, and /api and /checkout to an internal Application Load Balancer used as a CloudFront VPC origin with no public IP (step 4). The ALB sits in private app-tier subnets of a three-AZ VPC and forwards to an EKS cluster using Karpenter with Graviton on-demand and Spot nodes, running storefront, catalog, cart, checkout, orders and payments services. Each service has its own IAM role through EKS Pod Identity and gets secrets as files from the Secrets Store CSI driver. Checkout (step 5) talks to Aurora PostgreSQL through RDS Proxy (step 6) in the data tier, next to ElastiCache for Valkey. Over VPC endpoints rather than the NAT gateway, cart uses DynamoDB, orders publishes to SQS and EventBridge, and payments reads its provider API key from Secrets Manager (step 7), encrypted with customer managed KMS keys. Payments calls the external provider through the central egress Network Firewall." width="1500" height="900" loading="lazy"></a><figcaption>One request from browser to database, with the security controls at each hop. Numbers match the steps below.</figcaption></figure>

1. **Route 53** answers for `shop.example` with an alias to CloudFront. Health checks and failover records for the origin live here too, which matters later for DR.
2. **CloudFront** serves product images and JS bundles from S3 (private bucket, origin access control) and forwards `/api/*` and `/checkout/*` uncached. A good cache hit ratio is the single biggest scaling lever for a shop: on a sale day most of your traffic is people looking at the same 200 product pages.
3. **AWS WAF and Shield Advanced** are attached to the distribution, so attacks are absorbed at the edge before they reach your VPC. More on the rule set below.
4. **The ALB is internal.** CloudFront reaches it as a VPC origin, so it has no public IP and there's no "secret header" trick to maintain. If you can't use VPC origins yet, restrict the ALB security group to the `com.amazonaws.global.cloudfront.origin-facing` managed prefix list and check a custom header in a WAF rule on the ALB.
5. **Services run on EKS** with Karpenter choosing nodes: Graviton on-demand for checkout and payments, Spot for storefront and catalog. Every service has its own IAM role through EKS Pod Identity. Checkout writes with an idempotency key, so a retried request never creates a second order.
6. **RDS Proxy** pools connections to Aurora. Without it, a scale-out from 20 to 200 checkout pods turns into 200 × pool-size connections hitting the writer at the same moment.
7. **Secrets Manager** holds the payment provider key and database credentials, encrypted with a customer managed KMS key. Pods reach it, DynamoDB, SQS and S3 over VPC endpoints, not through the NAT gateway.

For a deeper look at every network checkpoint between the internet and a pod, see [from the internet to an EKS pod](/blog/aws-eks-request-path/).

### The WAF rule set

Order matters, because WAF evaluates rules by priority and stops at the first terminating action. This is roughly the web ACL I'd start with:

| Priority | Rule | Action | Why |
|---|---|---|---|
| 0 | IP allow-list for your own synthetic monitors and payment provider webhooks | Allow | So a rate rule never blocks your own canaries |
| 1 | Amazon IP reputation list, anonymous IP list | Block | Cheap, catches the obvious |
| 2 | Core rule set, known bad inputs, SQL database rule group | Block | OWASP-style injection and exploit patterns |
| 3 | Rate-based: 300 requests per 5 minutes per IP on `/login` | Block | Credential stuffing |
| 4 | Rate-based: 2,000 per 5 minutes per IP, all paths | Challenge | Scrapers, without hurting shoppers behind a shared NAT |
| 5 | Account takeover prevention (ATP) on `/login` | Managed | Checks for stolen credentials and login anomalies |
| 6 | Bot Control (targeted) on `/cart`, `/checkout`, `/login` | Managed, CAPTCHA on suspicious | Browser automation and inventory hoarding |
| 7 | Account creation fraud prevention (ACFP) on `/register` | Managed | Fake account farms |

Bot Control targeted, ATP and ACFP are paid per request on top of WAF, so scope them with a scope-down statement to the paths that need them. Turn on WAF logging to the Log Archive bucket, and always ship a new rule in **Count** mode for a day before switching it to Block. The number of shops that have blocked their own mobile app with a new rule is not small.

Shield Advanced is the line people debate because of its monthly fee. For a shop that makes most of its year's revenue in one week, three things pay for it: the Shield Response Team you can call during an attack, automatic application-layer DDoS mitigation that writes WAF rules for you, and cost protection that credits you for scaling charges caused by a DDoS.

### Secrets, done properly

- **Database credentials:** let RDS manage the master password in Secrets Manager (`ManageMasterUserPassword`), with rotation on. Applications use their own database users, also rotated, never the master.
- **Third-party API keys** (the payment provider, email, search): stored as secrets with a rotation Lambda that uses the provider's API to create a new key, stages it as `AWSPENDING`, tests it, then promotes it to `AWSCURRENT`. Most providers allow two live keys at once, which is what makes zero-downtime rotation possible.
- **Delivery to pods:** the Secrets Store CSI driver with the AWS provider mounts each secret as a file and refreshes it after rotation. Applications re-read the file on auth failure. Environment variables are read once at start, show up in `kubectl describe`, crash dumps and support bundles, and don't change when the secret does.
- **Encryption:** one customer managed KMS key per data class (payments, customer PII, general), so a key policy can say which roles can decrypt which class. The [envelope encryption article](/blog/cloud-kms-envelope-encryption/) explains why key separation matters more than "encrypted at rest".
- **Replication:** secrets and keys are replicated to the DR region (multi-Region KMS keys and Secrets Manager replica secrets), or failover stops at "access denied".
- **CI has no secrets at all.** GitHub Actions assumes a role through OIDC. If you still have an access key in your pipeline, [delete it](/blog/workload-identity-federation-ci/).

## Observability: alert on what customers feel

<figure class="diagram wide"><a href="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-observability.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-observability.svg" alt="Observability across accounts. In the shop-prod account, the same in both regions, an EKS cluster runs storefront, cart, checkout and payments services, all with the OpenTelemetry SDK, JSON logs carrying trace_id, and a Prometheus metrics endpoint. Checkout emits an orders_placed metric and payments a payment_result metric in CloudWatch embedded metric format. The CloudWatch Observability add-on, which is the CloudWatch agent plus Fluent Bit, sends traces to X-Ray over OTLP for Application Signals and Transaction Search, and metrics and logs to CloudWatch with Container Insights. An AMP managed collector scrapes Prometheus metrics into Amazon Managed Service for Prometheus. Outside-in checks, CloudWatch Synthetics canaries that browse, add to cart and check out with a test card every minute from three regions, and CloudWatch RUM for real-browser Core Web Vitals, also report to CloudWatch. A note says to use the Standard log class for logs you alarm on, Infrequent Access for verbose debug logs, and to send WAF, flow and ALB logs to S3 and Athena. In a central observability account, CloudWatch cross-account observability (an OAM sink) receives data from all prod accounts in both regions, Managed Grafana shows an SRE board and a business board with orders per minute and payment success percentage, and SLO burn-rate alarms for checkout (99.9 percent under 800 milliseconds) feed composite alarms per user journey, which notify SNS, then PagerDuty and Slack, then the on-call engineer." width="1500" height="830" loading="lazy"></a><figcaption>Signals flow from every prod account into one observability account, and only symptom-based SLO alarms page a human.</figcaption></figure>

A shop needs three kinds of signal, and most teams only build the first:

1. **Infrastructure health:** node CPU, pod restarts, database connections. Useful when debugging, rarely worth waking someone for. Prometheus metrics, scraped by the AMP managed collector, go to Amazon Managed Service for Prometheus and Grafana.
2. **Service behaviour:** request rate, errors and latency per service and per dependency, with traces that cross service boundaries. Instrument with OpenTelemetry, ship through the CloudWatch Observability EKS add-on, and use CloudWatch Application Signals to get service maps and SLOs without hand-building dashboards. Every log line carries the `trace_id`, so you can jump from a slow trace to its logs.
3. **Business outcomes:** orders per minute, payment success rate by method, add-to-cart to checkout conversion. Emit them from the code as embedded metric format logs. When payment success drops from 97% to 80% for one card scheme, this is the only signal that tells you within a minute.

Then add **outside-in checks**: Synthetics canaries that load the home page, search, add to cart and check out with a test card every minute from three regions, and CloudWatch RUM for what real browsers see. Canaries are what tell you the site is down when everything inside the VPC looks green, because the problem is DNS, a certificate or the CDN.

Pull all of it into one **observability account** with CloudWatch cross-account observability, so the on-call engineer has one place to look across prod, payments and both regions.

### What actually pages someone

Define SLOs on user journeys, not components:

| Journey | SLO (28 days) | Measured by |
|---|---|---|
| Checkout | 99.9% of requests succeed in under 800 ms | Application Signals SLO on the checkout service |
| Browse and search | 99.5% under 400 ms | ALB and service latency |
| Payment authorisation | 98% success, per card scheme | `payment_result` business metric |
| Site reachable | Canary passes from 2 of 3 regions | Synthetics |

Alarm on **burn rate**, meaning how fast you're spending the error budget. A fast-burn alarm (budget gone in about two days at the current rate) pages. A slow-burn alarm (budget gone within the month) opens a ticket. Wrap them in a composite alarm per journey so one incident sends one page, not forty.

Two cost notes, because observability bills surprise people. Use the CloudWatch Logs **Infrequent Access** log class for verbose application and debug logs you only search during an incident; it has a lower ingestion price but no metric filters or alarms. Send WAF, VPC flow and ALB logs straight to S3 and query them with Athena. And watch metric cardinality: one Prometheus label with a customer ID in it can create millions of series.

## Multi-region DR: warm standby you've actually tested

<figure class="diagram wide"><a href="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-multi-region-dr.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-production-ecommerce/aws-ecommerce-multi-region-dr.svg" alt="Multi-region warm standby with an RTO of 15 minutes and an RPO of seconds. Shoppers reach CloudFront, which uses one distribution for both regions; its origin is a Route 53 failover record, origin.shop.example, controlled by Route 53 Application Recovery Controller routing controls and a Region switch plan, so a failover is a data-plane call rather than a DNS edit. The primary route goes to us-east-1, which is active, and the standby route to us-west-2. Each region has the same stack in rows, with replication between them: internal ALB (serving all traffic in us-east-1, healthy with no traffic in us-west-2); EKS with 60 nodes in the primary and 15 warm nodes in the standby that Karpenter scales to 60, deployed from the same manifests with Argo CD; Aurora primary cluster with a writer and two readers, replicated by Aurora Global Database storage replication with lag typically under one second to a secondary cluster that is promoted on failover; DynamoDB global tables, multi-active with last writer wins, for carts, sessions and idempotency keys; ElastiCache Global Datastore with an asynchronously replicated, read-only secondary; S3 Cross-Region Replication with Replication Time Control for product images and order documents; Secrets Manager replica secrets; KMS multi-Region keys; and ECR cross-Region replication. A box lists what is not replicated and is rebuilt after failover: the OpenSearch product index, re-fed from the catalog; SQS in-flight messages, safe to replay because producers are idempotent; and scheduled jobs, enabled by the failover plan. A failover plan box lists eight steps: canaries fail and a composite alarm pages on-call; the incident lead approves failover; Karpenter scales us-west-2 EKS from 15 to 60 nodes; Aurora global failover promotes us-west-2; ElastiCache secondary is promoted; the ARC routing control is flipped; checkout success and p99 are watched; later the old primary is rebuilt as a secondary and traffic fails back in a quiet hour." width="1500" height="920" loading="lazy"></a><figcaption>us-east-1 serves, us-west-2 waits warm. Every stateful service has a replication path, and the failover plan is written down.</figcaption></figure>

### Pick a strategy from the numbers, not the buzzwords

AWS describes four DR strategies: backup and restore, pilot light, warm standby, and multi-site active/active. For an e-commerce platform the useful question is how much an hour of downtime costs. If the shop makes $2 million on Black Friday, an hour of outage on that day is around $80,000 of lost orders, plus the customers who don't come back.

- **Backup and restore** (hours) is fine for internal tools, not for the shop.
- **Pilot light** keeps data replicated but compute off. Recovery means creating a cluster, pulling images and warming caches under pressure, so plan on 30 to 60 minutes if everything goes right.
- **Warm standby** keeps a scaled-down copy running and serving health checks. Recovery is mostly scaling up and flipping traffic. This is where most shops should be: RTO around 15 minutes, RPO of seconds, at roughly 25 to 35% extra on the infrastructure bill.
- **Active/active** removes failover but makes you solve multi-writer data: two customers buying the last item in two regions at once. It's worth it for very large platforms. Most shops don't need it, and the ones that try often end up with a hidden primary anyway.

### What replicates, and how

- **Aurora PostgreSQL: Global Database.** Storage-level replication to the secondary region, typically under a second of lag. For a planned move use *switchover*, which waits for the secondary to catch up and loses nothing. For a real outage use *failover* with data loss allowed, which promotes the secondary in minutes. Watch `AuroraGlobalDBReplicationLag` and alarm on it.
- **DynamoDB: global tables.** Every replica accepts writes and conflicts resolve with last writer wins. That's fine for carts and sessions. It's not fine for stock counts, which is why inventory and orders live in Aurora with a single writer. If you need strongly consistent multi-region reads in DynamoDB, global tables now offer a multi-Region strong consistency mode across three regions, at the cost of higher write latency.
- **ElastiCache: Global Datastore** for the catalog and price cache. If it's lost, the cache refills from Aurora; size the readers for that cold start.
- **S3: Cross-Region Replication** with Replication Time Control, which comes with an SLA to replicate 99.99% of objects within 15 minutes.
- **Secrets and keys:** replica secrets and multi-Region KMS keys, as above. Forgetting these is the most common reason a DR test stalls.
- **Container images:** ECR cross-Region replication, and the standby nodes pull them ahead of time.
- **Configuration:** both clusters deploy from the same Git repository with Argo CD. The standby region is not a hand-built copy; it's the same code with a smaller node count.

### Failing over without editing DNS

The common mistake is a runbook that says "update the Route 53 record to point at us-west-2". During a regional event you don't want to depend on a control-plane API call working. Route 53 Application Recovery Controller gives you **routing controls**: simple on/off switches whose state is read by Route 53 health checks, served from a cluster of endpoints in five regions. Flipping one is a data-plane call that keeps working when other things don't.

On top of that, an ARC **Region switch plan** can orchestrate the whole sequence: scale compute, fail over Aurora Global Database, flip the routing control, with a manual approval step at the start. You can do the same with a Step Functions state machine; the point is that the steps are code that you run in game days, not a wiki page.

Keep a human in the decision. Automatic regional failover sounds attractive until a monitoring glitch moves your whole shop to another region on a Friday afternoon. Automate the *execution*, not the *decision*.

### Test it, or assume it doesn't work

Once a quarter, run a game day. Use AWS Fault Injection Service to break things in staging first (stop an AZ's worth of nodes, add latency to Aurora, block a dependency), then do a planned switchover of prod to us-west-2 in a quiet hour, run it there for a day, and switch back. Record the real RTO. The first time, it's usually three times the number on the slide, and the reasons are always mundane: a quota that's lower in the second region, a secret that wasn't replicated, a hard-coded endpoint.

## Five incidents, and what fixed them

These are the scenarios worth rehearsing. Times are local to the on-call engineer.

### 1. The limited-edition drop and the bot army

**What happened.** A trainer release goes live at 10:00. At 10:00:04 the `/cart/add` endpoint is at 40 times normal traffic. By 10:00:15 the stock is gone, and support starts getting messages from customers who never got past the product page. Three hours later the same pairs appear on resale sites.

**What the signals showed.** WAF sampled requests had real-looking browser user agents from thousands of residential IPs, so the per-IP rate rule barely fired. Bot Control's labels told a different story: most of the traffic was automated browsers.

**What fixed it, for the next drop.**

- Bot Control in targeted mode on `/cart` and `/checkout`, with the CAPTCHA action for requests labelled as automated, instead of block. Real customers on a shared network solve a puzzle; bots mostly don't.
- A rate-based rule keyed on the session cookie and the JA4 TLS fingerprint rather than the IP. Rotating residential proxies change IP; they tend not to change their TLS stack.
- A WAF Challenge (a silent JavaScript proof) on the product page itself, so a client that never ran the page's JS can't call the cart API.
- Business logic in the cart service: a per-account and per-card limit of two pairs per release, and a short queue in front of drops so stock is allocated fairly, not by who has the fastest script.
- All new rules shipped in Count mode the week before, and checked against the previous drop's logs in Athena.

### 2. us-east-1 has a bad afternoon

**What happened.** At 14:02 the checkout canary starts failing from two of three regions. Application Signals shows elevated errors from Aurora and from several AWS APIs in us-east-1. The AWS Health Dashboard confirms increased error rates in the region at 14:09.

**What fixed it.**

- 14:03: the fast-burn composite alarm on checkout pages the on-call engineer.
- 14:08: the incident lead decides to fail over after a quick look at error rates. That decision is the hard part, and the runbook gives a threshold: if checkout success is below 90% for 5 minutes and AWS is reporting a regional issue, go.
- 14:09: the Region switch plan starts. Karpenter scales the us-west-2 node pools; the warm 15 nodes already run every service, so nothing starts from zero.
- 14:12: Aurora global failover promotes the us-west-2 cluster. Seconds of orders may be lost from the replication lag, which is why checkout uses idempotency keys and the payment provider is the source of truth for payment status.
- 14:14: the ARC routing control is flipped. CloudFront's origin now resolves to us-west-2.
- 14:19: checkout success is back above 99% in us-west-2. Total impact: 17 minutes.
- Next day: a reconciliation job compares orders in the new primary with the payment provider's records for the 14:00 to 14:15 window, and fixes the handful of payments that succeeded without a stored order.

### 3. A payment API key in a public repository

**What happened.** On a Saturday, a secret-scanning alert fires: the live payment provider key was committed to a public fork of an internal tool. It was copied from a developer's local `.env` file.

**What fixed it.**

- Rotate immediately in Secrets Manager. The rotation function creates a new key with the provider, sets it as `AWSPENDING`, runs a zero-amount authorisation to test it, promotes it to `AWSCURRENT`, then revokes the old key. The CSI driver refreshes the mounted file within its polling interval, and the payments service re-reads it on the next 401. No deploy, no restart.
- Search the provider's logs for any use of the old key from unknown IPs.
- Fix the cause: developers use a restricted test-mode key, live keys never exist outside Secrets Manager, and pre-commit plus push protection scanning are mandatory on every repository.

The difference between a two-minute fix and a two-day fix here is whether rotation was already automated and tested before you needed it.

### 4. Black Friday: checkout p99 goes from 300 ms to 4 seconds

**What happened.** At 20:00 on Black Friday, the slow-burn alarm fires, then the fast-burn one. CPU on the pods is fine. Aurora CPU is fine.

**What the signals showed.** Traces in Application Signals showed most of the time spent *waiting for a database connection*, not running queries. The checkout HPA had scaled from 40 to 180 pods, each with a pool of 20 connections, and the writer had hit `max_connections`. New pods were waiting, retrying, and holding connections while they retried.

**What fixed it.**

- Right then: cap the checkout HPA at the number of pods the database can serve, and lower each pod's pool size. Latency recovered within minutes.
- Afterwards: RDS Proxy in front of Aurora so pods share a smaller set of real connections; read-only queries (order history, product availability) moved to the reader endpoint; and a load test in staging at 2× the previous peak, three weeks before the next sale, with the same HPA limits as prod.
- The lesson for the dashboard: add *saturation* signals for every shared dependency (connections in use against max, queue depth, Lambda concurrency), not just utilisation.

### 5. The NAT gateway bill

**What happened.** Cost Anomaly Detection flags NAT gateway spend at four times the usual daily amount for a week.

**What the signals showed.** VPC flow logs, queried in Athena, showed most NAT bytes going to S3 and ECR. Karpenter's churn of Spot nodes meant fresh nodes pulling 1.5 GB images many times a day, through the NAT gateway, at NAT data processing rates.

**What fixed it.**

- A gateway VPC endpoint for S3 (and DynamoDB), which has no hourly or data processing charge. ECR image layers are served from S3, so this alone removed most of the traffic.
- Interface endpoints for ECR API, STS, Secrets Manager, SQS and CloudWatch Logs.
- Smaller images and a `consolidateAfter` setting in Karpenter so nodes aren't replaced every few minutes for a tiny saving.
- A budget alert on NAT data processing specifically, per account.

## Cost: the levers that matter

E-commerce traffic is spiky and predictable, which is good news for cost. The biggest levers, roughly in order of impact for this kind of platform:

| Lever | Where | Typical effect |
|---|---|---|
| CloudFront cache hit ratio above 90% for static and product pages | Edge | Origin load and data transfer drop with it; the cheapest scaling there is |
| Compute Savings Plans for the steady baseline | EKS nodes, Lambda, Fargate | Big discount on the always-on part. Commit to the quiet-week floor, never the peak |
| Graviton instances | EKS nodes, Aurora, ElastiCache | Better price-performance for most JVM, Node.js, Go and Python services |
| Spot for stateless, interruptible work | Storefront, catalog, workers, all of dev | Large savings with Karpenter diversifying instance types. Keep checkout and payments on on-demand |
| VPC endpoints instead of NAT | Every VPC | Gateway endpoints for S3 and DynamoDB are free |
| Aurora I/O-Optimized when I/O is more than about 25% of the Aurora bill | Aurora | Predictable price for I/O-heavy order tables |
| S3 Intelligent-Tiering | Product images, order documents | Old product photos move to cheaper tiers on their own |
| Non-prod schedules | Staging and dev | Scale node pools and Aurora down at night and at weekends |
| Log classes and retention | CloudWatch Logs | Infrequent Access for verbose logs, 30-day retention unless you need more |
| Right-sizing | Everything | Compute Optimizer recommendations, reviewed monthly |

Then make cost visible to the teams that cause it: required tags turned into cost allocation tags, a monthly report per `Service`, AWS Budgets per account, and Cost Anomaly Detection alerting the owning team, not a central finance inbox. The warm standby region is a real cost; show it as its own line so nobody "saves money" by deleting it in March.

## Production-readiness checklist

- Accounts per environment and for payments, logs and security tooling, under Control Tower
- SCPs, RCPs and declarative policies attached to OUs and tested in a staging OU
- Humans through IAM Identity Center, CI through OIDC, no IAM users or access keys
- Internal ALB behind CloudFront VPC origins; WAF and Shield Advanced on the distribution
- WAF rules shipped in Count mode first, WAF logs in the Log Archive bucket
- Secrets in Secrets Manager with tested rotation, mounted as files, replicated to the DR region
- One KMS key per data class, multi-Region where data replicates
- SLOs on checkout, browse and payment, with burn-rate alarms and composite alarms per journey
- Canaries from three regions and RUM on the storefront
- Aurora Global Database, DynamoDB global tables, S3 CRR, ECR replication, all monitored for lag
- ARC routing controls and a scripted failover plan, run in a game day every quarter
- Load test at 2× last year's peak three weeks before the big sale
- Savings Plans on the baseline, Spot and Graviton where safe, VPC endpoints everywhere
- Everything above in Terraform, reviewed in pull requests

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the account names, regions and CIDRs to match your platform.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-production-ecommerce/aws-production-ecommerce.drawio)
- [Multi-account landing zone](/assets/diagrams/aws-production-ecommerce/aws-ecommerce-landing-zone.drawio)
- [Request path and edge security](/assets/diagrams/aws-production-ecommerce/aws-ecommerce-request-path.drawio)
- [Observability and alerting](/assets/diagrams/aws-production-ecommerce/aws-ecommerce-observability.drawio)
- [Multi-region DR (warm standby)](/assets/diagrams/aws-production-ecommerce/aws-ecommerce-multi-region-dr.drawio)

Account names, CIDRs, node counts and SLO targets are examples. Check current quotas, prices and regional availability for your own regions before you build.

## References

- [AWS Control Tower: landing zone concepts](https://docs.aws.amazon.com/controltower/latest/userguide/what-is-control-tower.html)
- [Organizing your AWS environment using multiple accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/organizing-your-aws-environment.html)
- [Service control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- [Resource control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_rcps.html)
- [Declarative policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_declarative.html)
- [CloudFront VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)
- [AWS WAF Bot Control](https://docs.aws.amazon.com/waf/latest/developerguide/waf-bot-control.html)
- [AWS WAF account takeover prevention](https://docs.aws.amazon.com/waf/latest/developerguide/waf-atp.html)
- [AWS Shield Advanced](https://docs.aws.amazon.com/waf/latest/developerguide/shield-chapter.html)
- [Secrets Manager rotation](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html)
- [Secrets Store CSI driver with Amazon EKS](https://docs.aws.amazon.com/secretsmanager/latest/userguide/integrating_csi_driver.html)
- [CloudWatch Application Signals](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Monitoring-Sections.html)
- [CloudWatch cross-account observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html)
- [Disaster recovery of workloads on AWS (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html)
- [Aurora Global Database switchover and failover](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)
- [DynamoDB global tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [Route 53 Application Recovery Controller](https://docs.aws.amazon.com/r53recovery/latest/dg/what-is-route53-recovery.html)
- [AWS Fault Injection Service](https://docs.aws.amazon.com/fis/latest/userguide/what-is.html)
- [Cost optimization pillar, AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
