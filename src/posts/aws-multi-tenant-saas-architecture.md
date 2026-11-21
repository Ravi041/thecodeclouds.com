---
title: "Multi-tenant SaaS on AWS: silo, pool and bridge, tenant isolation, noisy neighbours and cost per tenant"
description: "How to build a high-throughput multi-tenant SaaS on AWS: choosing silo, pool or bridge per tier, enforcing tenant isolation with IAM session tags, DynamoDB LeadingKeys and Postgres row-level security, stopping noisy neighbours with usage plans and SQS fair queues, metering cost per tenant, and onboarding an enterprise tenant into its own account in 90 minutes. Mapped to the AWS Well-Architected SaaS Lens, with four editable draw.io diagrams."
date: 2026-11-21T03:14:00Z
category: Cloud & DevOps
coverLabel: "One platform.\n1,800 tenants.\nNo noisy neighbours."
coverCode: "pool · bridge · silo · cost per tenant"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-multi-tenant-saas-architecture.jpg
coverImageAlt: "Cloud & DevOps cover reading 'One platform. 1,800 tenants. No noisy neighbours.', with the AWS logo."
---
Most SaaS products become multi-tenant by accident. The first ten customers each get a database, then someone adds a `tenant_id` column to save money, then a large customer asks for "their own environment" and gets a copy of the stack that nobody remembers to patch. Two years later the team has three architectures, no idea what each customer costs to serve, and a Monday morning where one customer's bulk import makes the product slow for everyone else.

This article is the design I'd use for a B2B SaaS on AWS that has to serve both ends of the market: hundreds of small self-serve tenants who need the product to be cheap, and a handful of enterprise tenants who need it to be isolated, auditable and in their region. It follows the vocabulary of the [AWS Well-Architected SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html): **silo**, **pool** and **bridge** deployment models, a **control plane** and an **application plane**, and **tenant context** that travels with every request.

The example is a document-processing product. Customers upload contracts and invoices, the platform extracts data, and customers search and export it. The numbers are realistic for a company in its fourth or fifth year. Yours will differ, but the decisions mostly won't.

There are four diagrams. Each is an editable `.drawio` file built with the official AWS shapes that ship with draw.io, so you can change them to fit your own platform.

## The short version

- **Choose the deployment model per tier, not per product.** Basic tenants share everything (pool). Pro tenants share compute but get their own database and key (bridge). Enterprise tenants get their own AWS account (silo). One codebase, one pipeline, three shapes.
- **Build the control plane first.** Tenant registry, onboarding, identity, tier configuration, metering and billing are a product of their own. Without them every new tenant is a ticket.
- **Isolation is enforced by AWS, not by `WHERE tenant_id = ?`.** Tenant-scoped credentials with IAM session tags, `dynamodb:LeadingKeys`, S3 prefix policies, KMS encryption context and Postgres row-level security mean a bug in a query returns `AccessDenied`, not another customer's data.
- **Every shared layer needs a per-tenant limit.** API Gateway usage plans per tier, SQS fair queues keyed on tenant, per-tenant worker concurrency, separate lanes for bulk work. A big tenant may be slower. It may never make others slower.
- **Measure cost per tenant from day one.** Usage events with a `tenant_id`, joined in Athena with the Cost and Usage Report and split cost allocation for EKS. It's the only way to know which plans lose money.
- **Onboarding is code.** Self-serve tenants are live in under a minute. An enterprise silo account is vended, baselined, deployed and tested in about 90 minutes with no human steps.

## Requirements

Requirements drive every choice below, so here they are first. These are the numbers for the example product today, with headroom for the next 18 months.

### Business and functional requirements

| Requirement | Detail |
|---|---|
| Tenants | 1,800 today: 1,640 Basic, 150 Pro, 10 Enterprise. Plan for 5,000 |
| Self-serve sign-up | From sign-up (or an AWS Marketplace subscription) to a working account in under 2 minutes |
| Enterprise onboarding | From signed contract to a production environment in under 1 business day, without a project team |
| Tier changes | Upgrade Basic to Pro, or Pro to Enterprise, without data loss and with less than 5 minutes of read-only time |
| Identity | Email and password for Basic, SAML or OIDC federation to the customer's IdP for Pro and Enterprise |
| Metering | Usage per tenant (documents processed, pages, storage, API calls) available hourly for billing |
| Offboarding | Export a tenant's data on request, delete everything after the contractual retention period, with evidence |

### Non-functional requirements

| Area | Target |
|---|---|
| Throughput | 9,000 API requests per second at peak, 45 million documents a month, bursts of 4 million documents from a single tenant |
| Latency | API p99 under 400 ms for reads; 95% of interactively uploaded documents processed within 2 minutes |
| Noisy neighbours | No tenant's traffic may move another tenant's p99 by more than 20% |
| Availability | 99.9% monthly for the pool, 99.95% for Enterprise silos (contractual) |
| Recovery | Pool: RPO 5 minutes, RTO 1 hour. Enterprise: per contract, typically RPO 1 minute, RTO 30 minutes |
| Isolation | No code path can read or write another tenant's data, even with a bug. Cross-tenant access attempts are detected and alerted |
| Data residency | EU tenants' documents stay in `eu-central-1`; US tenants in `us-east-1` |
| Encryption | All data encrypted at rest with KMS. Pro tenants get their own key. Enterprise tenants can bring their own key and revoke it |
| Cost | Infrastructure cost under 18% of revenue overall, and every tier gross-margin positive |
| Operations | One deployment pipeline for all tenants. A security fix reaches every pool and silo within 24 hours |

### The enterprise tenant that shapes the design

One of the Enterprise customers, a European bank I'll call acme-bank, signed with these extra requirements. Almost every enterprise SaaS deal has a version of this list, so it's worth designing for from the start:

- About 22 million documents a year, with month-end peaks of 1.5 million documents in two days.
- Data must stay in the EU, in an environment no other customer shares.
- Encryption with a key the bank controls in its own AWS account, which it can disable to make its data unreadable.
- No public endpoint. Access only from the bank's network, over AWS PrivateLink.
- Single sign-on through the bank's own IdP, with its own group-to-role mapping.
- Daily export of audit logs to an S3 bucket the bank owns.
- 99.95% availability, a named maintenance window, and the right to run its own penetration test once a year.

Hold on to that list. It is why the silo tier exists.

## Silo, pool or bridge: pick per tier

The SaaS Lens describes three [deployment models](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html). In practice you will use all three, attached to tiers:

| | Pool | Bridge | Silo |
|---|---|---|---|
| What is shared | Everything: compute, queues, tables, buckets | Compute and API tier; storage and keys are per tenant | Nothing. One AWS account per tenant |
| Who gets it here | Basic (1,640 tenants) | Pro (150 tenants) | Enterprise (10 tenants) |
| Isolation enforced by | IAM session tags, LeadingKeys, RLS, encryption context | As pool, plus a database and KMS key per tenant and a dedicated worker namespace | The account boundary, plus everything the pool does |
| Noisy-neighbour risk | Highest, needs every control below | Medium: compute is shared, storage isn't | None from other tenants |
| Infra cost per tenant per month (example) | about $35 on average | about $260 | $2,500 to $4,000 floor before any traffic |
| Onboarding time | Under a minute | A few minutes | About 90 minutes, automated |
| Operational cost | One stack per region | One stack plus 150 databases | Ten more stacks to deploy, monitor and patch |

The silo floor is the number that matters for pricing. An EKS control plane, three NAT gateways or a shared egress path, a minimum Aurora cluster with a reader in a second AZ, logging, backups and security tooling all cost money before the tenant sends a single request. If Enterprise is priced below that floor plus support, every new enterprise customer makes the business worse.

The other number that matters is operational cost. A silo account that is deployed by hand is a liability; ten of them is an outage waiting to happen. Silos only work when they are built by the same pipeline from the same templates as the pool, which is what the onboarding automation below is for.

## Reference architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-tenant-saas/saas-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-tenant-saas/saas-reference.svg" alt="Reference architecture. At the top, a control plane account shared by all tenants and run by the SaaS provider: an admin API in API Gateway used by tenant admins and provider staff, a tenant management service in Lambda writing to a DynamoDB tenant registry with id, tier, region, status, plan and owner, an onboarding workflow in Step Functions with a pool and a silo path, tier configuration in AppConfig, a Cognito user pool with custom tenant_id and tier attributes and federation per tenant, and a control plane EventBridge bus carrying TenantOnboarded, TierChanged and Offboard events. Usage events arrive through Firehose to S3 and are queried in Athena for metering and cost per tenant, which feeds billing through AWS Marketplace metering or the provider's own billing system and a QuickSight tenant health dashboard. A deployment pipeline in CodePipeline deploys in waves, pool first, then silos. Bottom left, a pool account for Basic and Pro tenants with one stack per region in us-east-1 and eu-central-1: AWS WAF with per-IP rate rules, API Gateway REST with a Lambda authorizer and a usage plan per tier, and an EKS cluster with Karpenter on Graviton and Spot running a shared api namespace, ingest workers with a per-tenant concurrency cap, and dedicated pro-tenant namespaces for the bridge tier with their own worker pool, role, ResourceQuota and NetworkPolicy. Workers read from an SQS fair queue with MessageGroupId set to the tenant id, and tenant-specific rules run in Lambda tenant isolation mode. Pooled data is partitioned by tenant: DynamoDB with partition keys starting TENANT#id and a LeadingKeys policy, S3 with a tenant prefix and prefix-scoped access, Aurora PostgreSQL with shared tables and row-level security for Basic and a database per tenant for Pro, KMS with tenant id in the encryption context and a separate key per Pro tenant, and CloudWatch embedded metric format metrics per tenant that flow to the control plane as usage events. Bottom right, silo accounts, one per Enterprise tenant: acme-bank in eu-central-1 reaches a private API Gateway over PrivateLink from its own VPC, then a dedicated EKS cluster running the same Helm chart, with dedicated Aurora, a dedicated S3 bucket and a bank-owned key used through cross-account KMS. Silo accounts are vended by Control Tower Account Factory, tagged with tenant_id and deployed by the same pipeline as the pool." width="1500" height="980" loading="lazy"></a><figcaption>One control plane, a pooled application plane per region for Basic and Pro, and a silo account per Enterprise tenant, all deployed from the same pipeline.</figcaption></figure>

### The control plane

The control plane is everything that exists *because* the product has tenants. It lives in its own account and is never multi-tenant in the data sense, because it serves the provider, not the customers.

- **Tenant registry** (DynamoDB): one item per tenant with id, tier, home region, status (`PROVISIONING`, `ACTIVE`, `SUSPENDED`, `OFFBOARDING`), plan, and for silos the account id and endpoint. Every other component looks tenants up here.
- **Tenant management and onboarding**: an admin API in API Gateway in front of Lambda, and a Step Functions state machine that runs onboarding, tier changes and offboarding.
- **Identity**: a Cognito user pool with `custom:tenant_id` and `custom:tier` attributes. Basic tenants sign in with email and password; Pro and Enterprise tenants federate their own SAML or OIDC IdP. The tenant attributes are set by the control plane and are *not writable* by the app client, so a user can't change their own tenant.
- **Tier configuration** (AppConfig): rate limits, quotas, features and per-tenant overrides as configuration. Changing a tenant's limits is a config deployment with validation and rollback, not a code change.
- **Metering and billing**: usage events from every application plane land in S3 through Firehose, Athena turns them into usage and cost per tenant, and billing either reports to [AWS Marketplace metering](https://docs.aws.amazon.com/marketplace/latest/userguide/metering-for-usage.html) or to the provider's own billing system.
- **Control plane events** (EventBridge): `TenantOnboarded`, `TierChanged`, `TenantSuspended`. The application plane subscribes to these instead of the control plane reaching into it.

If you don't want to build all of this from scratch, the open-source [SaaS Builder Toolkit for AWS](https://github.com/awslabs/sbt-aws) gives you CDK constructs for a control plane and an application plane that talk over EventBridge, in the same shape as this design.

### The application plane

The application plane is the product. The pool runs one stack per region (`us-east-1` and `eu-central-1`), and a tenant lives in exactly one home region chosen at sign-up.

- **Edge and API**: AWS WAF with per-IP rate rules and Bot Control, then API Gateway (REST). A Lambda authorizer validates the JWT, checks the tenant is `ACTIVE` in the registry and returns the tenant id and the usage plan key. The REST API type matters here: [usage plans and API keys](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html) are a REST API feature.
- **Compute**: one EKS cluster per region, Karpenter provisioning Graviton on-demand nodes for the API and Spot for ingest workers. Basic tenants share the `api` and `ingest` namespaces. Each Pro tenant gets a `pro-<tenant>` namespace with its own worker deployment, ResourceQuota, a [default-deny NetworkPolicy](/blog/kubernetes-network-policies-default-deny/) and its own IAM role. That namespace is the "bridge": shared cluster, dedicated workers.
- **Async processing**: an SQS fair queue for interactive uploads and a separate bulk queue for imports. More on both in the noisy-neighbour section.
- **Tenant-specific code**: some customers upload their own extraction rules. Those run in Lambda functions using [tenant isolation mode](https://docs.aws.amazon.com/lambda/latest/api/API_TenancyConfig.html), where Lambda keeps execution environments separate per tenant id, so one tenant's code and in-memory state never share an environment with another tenant's.
- **Data**: DynamoDB for document metadata, S3 for the documents, Aurora PostgreSQL for reporting and search filters, all partitioned by tenant. Basic tenants share Aurora tables with row-level security. Pro tenants each get a database on a shared Aurora cluster, which keeps tier upgrades simple: moving a tenant from Basic to Pro is a copy of its rows into a new database, not a migration to a new engine.

### The silo accounts

Each Enterprise tenant gets an AWS account in a `SaaS-Silo` OU, vended by Control Tower Account Factory and deployed by the same pipeline as the pool. Inside is the same Helm chart and the same Terraform or CDK modules, with a few switches flipped: private API Gateway endpoint reached through PrivateLink, a dedicated Aurora cluster, a dedicated bucket, and encryption with a key in the customer's own account.

For acme-bank that last point means a KMS key in the bank's account whose key policy grants the silo's application role `kms:Decrypt` and `kms:GenerateDataKey`. If the bank disables the key, the platform can no longer read its documents. That is a feature the bank's risk team asked for, and also something your runbooks must expect: a revoked customer key looks exactly like an outage from the inside.

Silos still send usage events and operational metrics to the control plane, so the provider has one view of every tenant whichever model it runs in.

## Tenant isolation: enforce it below the code

The SaaS Lens is blunt about this: [tenant isolation](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/preventing-cross-tenant-access.html) cannot rest on developers remembering a `WHERE` clause. In a pool, the code must run with credentials that *can't* reach another tenant's data. Here's the path of one request.

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-tenant-saas/saas-tenant-context.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-tenant-saas/saas-tenant-context.svg" alt="Tenant context on one request in the pool tier. Step 1: a user of tenant t-4821 on the Pro tier signs in to the Cognito user pool, which supports OIDC and SAML federation for enterprise IdPs, and receives an ID token whose claims include custom:tenant_id t-4821 and custom:tier pro; the claims are read-only to app clients. Step 2: the request reaches API Gateway REST with Authorization Bearer JWT. Step 3: a Lambda authorizer verifies the JWT, checks the tenant registry in DynamoDB for status, tier and key id, and returns tenantId, tier and usageIdentifierKey; the key selects the usage plan pro, 300 requests per second with a burst of 600 and 20 million requests a month. Step 4: the documents service pod in the shared api namespace on EKS has tenant context middleware that reads tenantId from the authorizer context, never from the request body, and puts it on every log line and metric. Its Pod Identity role documents-svc can only assume another role. Step 5: token vending calls STS AssumeRole with TagSession into the role tenant-scoped-access with tag TenantId t-4821, and caches the 15-minute credentials per tenant. Step 6: with those scoped credentials, DynamoDB access is limited by a dynamodb:LeadingKeys condition to TENANT# plus the principal tag, S3 access to the docs/tenant= prefix for the principal tag, and KMS use to an encryption context whose tenant_id equals the principal tag. Step 7: Aurora PostgreSQL for the Basic tier sets app.tenant_id with set_config for the transaction and has a row-level security policy on every table; the application database role has no BYPASSRLS, is not the table owner, and the tables use FORCE ROW LEVEL SECURITY. A box explains that when a bug asks for TENANT#t-1007 with t-4821 credentials, DynamoDB returns AccessDeniedException, nothing leaks, and the CrossTenantDenied metric pages security. Another box notes that every hop records the tenant: API Gateway access logs with the authorizer tenant id, service logs and EMF metrics with tenant_id, tier and operation, and CloudTrail data events with a role session name per tenant." width="1500" height="860" loading="lazy"></a><figcaption>The tenant id comes from the identity provider, is checked by the authorizer, and ends up as an IAM session tag that DynamoDB, S3 and KMS enforce. Numbers match the steps below.</figcaption></figure>

1. **Sign-in.** Cognito issues a token whose `custom:tenant_id` and `custom:tier` claims were set by the control plane. A pre token generation trigger can add claims such as the tenant's home region.
2. **API Gateway** receives the request with the bearer token.
3. **The Lambda authorizer** verifies the token, confirms the tenant is active (cached, so the registry isn't on the hot path), and returns the tenant id in the authorizer context plus a `usageIdentifierKey`. With the API's key source set to `AUTHORIZER`, that key picks the tenant's usage plan without the client ever seeing an API key.
4. **The service** reads the tenant id only from the authorizer context. A tenant id in a header, query string or body is ignored. A middleware puts it on every log line, trace and metric.
5. **Token vending.** The pod's own [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) role can do almost nothing except assume a `tenant-scoped-access` role with a `TenantId` session tag. The resulting 15-minute credentials are cached per tenant in the pod.
6. **AWS enforces the boundary** on DynamoDB, S3 and KMS using `${aws:PrincipalTag/TenantId}` in the policy.
7. **Postgres enforces it** with row-level security for the pooled tables.

This is the pattern AWS describes in [How to implement SaaS tenant isolation with ABAC and AWS IAM](https://aws.amazon.com/blogs/security/how-to-implement-saas-tenant-isolation-with-abac-and-aws-iam/). One role with session tags replaces a role per tenant, which matters when you have 1,800 tenants and an [IAM roles quota](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html) per account.

### The tenant-scoped policy

The trust policy on `tenant-scoped-access` allows `sts:AssumeRole` and `sts:TagSession` only from the service roles, and only when a `TenantId` tag is present. The permissions policy does the isolation:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OwnItemsOnly",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                 "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem",
                 "dynamodb:BatchWriteItem"],
      "Resource": "arn:aws:dynamodb:*:111122223333:table/documents",
      "Condition": {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "TENANT#${aws:PrincipalTag/TenantId}",
            "TENANT#${aws:PrincipalTag/TenantId}#*"
          ]
        }
      }
    },
    {
      "Sid": "OwnPrefixOnly",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::docs-prod-euc1/tenant=${aws:PrincipalTag/TenantId}/*"
    },
    {
      "Sid": "OwnEncryptionContextOnly",
      "Effect": "Allow",
      "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:eu-central-1:111122223333:key/<pool-key-id>",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:tenant_id": "${aws:PrincipalTag/TenantId}"
        }
      }
    }
  ]
}
```

Three details that bite people:

- **Never put `dynamodb:Scan` in this policy.** A Scan has no leading key, and `ForAllValues` on an empty set evaluates to true, so the condition would allow it. Scans across tenants belong in an admin role, not a tenant role.
- **Use a delimiter in keys.** `TENANT#t-48#*` does not match `TENANT#t-4821`, but a key scheme without the `#` would let tenant `t-48` match a prefix of `t-4821`. The second pattern exists for hot tenants whose partition keys are write-sharded as `TENANT#t-4821#0` to `TENANT#t-4821#7`.
- **Add a `ListBucket` statement with an `s3:prefix` condition** if the service lists objects; otherwise it can't, and someone will "fix" it with a bucket-wide list.

Encryption context is what makes one KMS key safe to share across Basic tenants: every encrypt call passes `tenant_id` as context, the context is logged in CloudTrail, and a decrypt with the wrong tenant's credentials fails. For why this is cheaper and safer than one key per row, see [envelope encryption explained](/blog/cloud-kms-envelope-encryption/). Pro tenants get a key each, which costs $1 a month per key and lets you give a tenant a crypto-shredding guarantee at offboarding.

### Row-level security in Aurora PostgreSQL

For the shared reporting tables, Postgres enforces the same rule:

```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- per request, inside the transaction:
BEGIN;
SELECT set_config('app.tenant_id', 't-4821', true);  -- true = local to this transaction
SELECT * FROM invoices WHERE status = 'OPEN';        -- only t-4821's rows
COMMIT;
```

The application connects as a role that does not own the tables and does not have `BYPASSRLS`. `FORCE` makes the policy apply even to the owner, which protects you from the migration role being reused by accident. Setting the value transaction-local means a pooled connection can't carry one tenant's id into the next tenant's request. If you put RDS Proxy in front, check that your driver's statements don't pin sessions, and watch the `DatabaseConnectionsCurrentlySessionPinned` metric after the change.

### Kubernetes: namespaces are not tenants, but they help

Namespaces don't isolate the kernel, so the pool never runs a tenant's own code in a shared pod. What namespaces do give the bridge tier is a clean unit for quotas, network policy and identity. EKS Pod Identity adds [session tags](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-abac.html) such as `kubernetes-namespace` and `kubernetes-service-account` to the role session, so a Pro tenant's workers in `pro-t-4821` can be limited with a condition on `aws:PrincipalTag/kubernetes-namespace` without a role per tenant.

### Detect the attempts, not just block them

A blocked cross-tenant request is a bug or an attack, and both deserve a page. The services count `AccessDeniedException` responses from tenant-scoped calls as a `CrossTenantDenied` metric with the tenant id as a dimension. Any value above zero alarms. CloudTrail data events for the documents table and bucket record the role session name, which includes the tenant, so the investigation starts with "which tenant, which service, which deploy" instead of a guess.

Isolation also needs testing. Every release runs an isolation test suite: sign in as tenant A, try to read tenant B's documents through every API, and expect a 403 or 404 every time. It runs against the pool and against each new silo before it goes live.

## Noisy neighbours: a limit at every shared layer

Here's the incident that made this section exist.

**Monday, 09:00.** A Basic-tier retail customer, acme-retail, starts a migration from its old system: 4 million documents in one import. Every document becomes a message on the shared processing queue. Within 20 minutes the queue holds 3.1 million messages. Workers scale out as designed, which moves the bottleneck to DynamoDB, where acme-retail's documents all land under one partition key prefix and start throttling. Every other tenant's documents now wait behind acme-retail's.

By 09:40 the p95 time from upload to processed is 18 minutes for every tenant, API p99 is 2.4 seconds because the API pods share nodes with workers that are retrying throttled writes, and support has 63 tickets. The platform did exactly what it was built to do. It just had no idea that 4 million of those messages belonged to one customer.

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-tenant-saas/saas-noisy-neighbor.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-tenant-saas/saas-noisy-neighbor.svg" alt="Noisy-neighbour controls in six columns. Edge: acme-retail running a bulk import of 4 million documents and 1,799 other tenants with normal traffic both pass AWS WAF with per-IP rate rules and Bot Control. API: API Gateway applies a usage plan per tier, Basic 50 requests per second with burst 100, Pro 300 with burst 600, Enterprise on its own stage in its silo, with 429 and Retry-After over the limit; bulk imports use a separate route with its own daily usage plan quota. Async work: interactive work goes to an SQS fair queue with MessageGroupId set to the tenant id, which keeps dwell time low for quiet tenants while one tenant builds a backlog; bulk imports go to a lower priority bulk queue with its own worker pool. Compute: ingest workers scale with KEDA on queue depth and take a per-tenant concurrency token from a Valkey token bucket in ElastiCache; tenant rules run in Lambda tenant isolation mode with reserved concurrency. Data: DynamoDB gives hot tenants write-sharded keys, Aurora uses a per-tenant role with statement_timeout, and S3 uses a prefix per tenant to spread request rate. Detect: per-tenant metrics in CloudWatch embedded metric format with tenant_id as a dimension for the top tenants, Contributor Insights for top tenants by requests and throttles, and an alarm when one tenant uses more than 25 percent of shared capacity. A table compares the Monday incident with one shared queue and with fair queues and caps: other tenants' queue age p95 went from 18 minutes to 35 seconds, their API p99 from 2.4 seconds to 310 milliseconds, the acme-retail import took 5 hours 40 minutes instead of 4 hours 10 minutes, DynamoDB throttled writes went from 1.9 million to zero and support tickets from 63 to one. Rules of thumb: limits come from tier configuration, the tenant id for limits comes from the authorizer not a client header, a big tenant may be slower but never makes others slower, bulk and interactive work never share a queue or worker pool, and a tenant consistently above 25 percent of a shared resource is a sales conversation about a bigger tier." width="1500" height="900" loading="lazy"></a><figcaption>One per-tenant control at each shared layer, and the before-and-after numbers from the Monday import. Example figures.</figcaption></figure>

### The controls, layer by layer

| Layer | Control | Setting in the example |
|---|---|---|
| Edge | AWS WAF rate-based rules per IP, Bot Control | 2,000 requests per 5 minutes per IP, challenge above that |
| API | API Gateway usage plan per tier, selected by the authorizer | Basic 50 rps / burst 100, Pro 300 / 600. A 429 with `Retry-After` above the limit |
| API | Separate bulk-import route with a daily quota | Basic 100,000 documents a day through the bulk API, more on request |
| Queue | [SQS fair queues](https://aws.amazon.com/blogs/compute/building-resilient-multi-tenant-systems-with-amazon-sqs-fair-queues/), `MessageGroupId` = tenant id | Interactive queue only. Bulk goes to its own queue |
| Workers | Per-tenant concurrency cap with a token bucket in ElastiCache (Valkey) | Basic 20 concurrent jobs, Pro 100, bulk lane 50 per tenant |
| Workers | Bulk and interactive on separate Karpenter NodePools | Bulk on Spot only, interactive on on-demand |
| Functions | Reserved concurrency per function for tenant rules | So tenant code can't drain the account's Lambda concurrency |
| DynamoDB | Write sharding for tenants above a threshold, on-demand maximum throughput per table | Keys `TENANT#id#0..7` for the top 2% of tenants |
| Aurora | Per-tenant role with `statement_timeout` and connection limit (Pro) | 30 seconds, 40 connections |
| Detection | Per-tenant metrics, Contributor Insights, alarm on share of capacity | Page when one tenant exceeds 25% of a shared resource for 15 minutes |

A few of these deserve a sentence more.

**Usage plans are a fairness tool, not a security control.** AWS documents API Gateway throttling and quotas as best-effort, and says API keys should not be used for authentication. They're perfect for what they are here: a per-tier rate limit that the authorizer selects. Authentication stays with the JWT.

**Fair queues fix the shape of the backlog, not its size.** With `MessageGroupId` set to the tenant id on a standard queue, SQS detects that one group has built up a large backlog and delivers messages from the other groups first, so quiet tenants keep their low dwell time. acme-retail's 4 million messages still have to be processed; they just stop being everyone else's problem. SQS keeps standard-queue throughput, and fair queues work as targets for SNS and EventBridge, so the producers don't change.

**The tenant id used for limits must come from the authorizer.** It is tempting to rate-limit in WAF on an `X-Tenant-Id` header. Don't: the client controls that header, so one tenant could spend another tenant's budget, or get a competitor throttled. Per-tenant limits live behind the authorizer, where the tenant id is verified.

**DynamoDB will tell you who the hot tenant is.** A partition delivers up to 3,000 read units and 1,000 write units per second. When one tenant's writes all share a partition key prefix, adaptive capacity helps, but [CloudWatch Contributor Insights for DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/contributorinsights_HowItWorks.html) shows the most-throttled keys within minutes, and the key starts with the tenant id. That is the signal to move a tenant to sharded keys.

**After the fix,** the same import the next month ran through the bulk API and the bulk queue. Other tenants' p95 queue age stayed at 35 seconds and API p99 at 310 ms. acme-retail's import took 5 hours 40 minutes instead of 4 hours 10, which is the honest trade-off: the big tenant got a bit slower so 1,799 others didn't notice. It also got a proactive message from its account manager about the Pro tier, which is the commercial half of noisy-neighbour management.

## Metering and cost per tenant

You can't price a SaaS product without knowing what each tenant costs to serve, and the AWS bill doesn't know what a tenant is. You have to tell it.

<figure class="diagram wide"><a href="/assets/diagrams/aws-multi-tenant-saas/saas-onboarding-metering.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-multi-tenant-saas/saas-onboarding-metering.svg" alt="Top half, onboarding in the control plane account. Sign-up through AWS Marketplace, self-serve or sales calls the admin API POST /tenants, which starts the onboarding state machine. Step 1 writes the tenant record with status PROVISIONING. Step 2 creates identity: a Cognito group or SAML IdP and the first admin user. A choice on tier follows. The Basic and Pro pool path takes about 40 seconds: create the API key and usage plan, for Pro only create a database, a KMS key and a pro-tenant namespace through GitOps, and seed configuration in AppConfig. The Enterprise silo path takes about 90 minutes with no human steps: Control Tower Account Factory creates a new account in the SaaS-Silo OU, CloudFormation StackSets apply the baseline of roles, logging and guardrails, CodePipeline deploys the app stack at the same version as the pool with the tenant's region and key, and CodeBuild runs smoke tests and isolation tests from outside. Both paths publish a TenantOnboarded event on EventBridge, which sets the registry status to ACTIVE, triggers billing, metering and dashboards, and sends a welcome email with the admin invite through Amazon SES. Offboarding is the same machine in reverse: suspend, export data for the customer, wait the contractual retention period, then delete data and keys and close the silo account. Bottom half, metering and cost per tenant. Services emit usage events with tenant id, metric and quantity to Firehose, which buffers and converts them to Parquet in an S3 usage lake partitioned by tenant and date. AWS Data Exports writes CUR 2.0 with split cost allocation data for EKS pods, and silo accounts carry a tenant_id cost allocation tag; both land in an S3 cost data bucket. Athena joins shared cost multiplied by each tenant's usage share with direct silo cost, feeding a QuickSight dashboard of cost per tenant and margin per tier, and billing through AWS Marketplace BatchMeterUsage hourly or the provider's own billing system. An example month for one Basic tenant: plan price 490 dollars, 2.1 percent of pool requests, 3.1 percent of documents processed, a shared pool cost of 61,000 dollars, 1,891 dollars allocated by document share, 340 dollars of direct S3, KMS and egress cost, a cost to serve of 2,231 dollars and a gross margin of minus 355 percent. The fix is to price Basic on documents processed, not seats, and cap bulk imports." width="1500" height="900" loading="lazy"></a><figcaption>Top: one onboarding workflow with a pool path and a silo path. Bottom: usage events joined with the AWS bill to give cost and margin per tenant.</figcaption></figure>

### Three sources of truth

1. **Usage events from the code.** Every service emits a small event for things a customer could be billed for or that drive cost: documents processed, pages OCR'd, bytes stored, API calls, Lambda milliseconds for tenant rules. They go through Firehose to S3 as Parquet, partitioned by tenant and day. CloudWatch embedded metric format is great for *operational* per-tenant metrics, but keep the tenant dimension to the metrics you alarm on, because every unique dimension value is a separate custom metric you pay for.
2. **The bill, with split cost allocation.** AWS Data Exports (CUR 2.0) with [split cost allocation data for EKS](https://docs.aws.amazon.com/cur/latest/userguide/split-cost-allocation-data.html) breaks node cost down to pods by their CPU and memory reservation, by namespace and by Kubernetes labels. For the bridge tier, where each Pro tenant has a namespace, that's direct cost per tenant with no estimation.
3. **Tags for silos.** Every silo account and its resources carry a `tenant_id` cost allocation tag, and the account id is in the registry. A silo's cost is simply its account's bill.

Shared costs in the pool (the API pods, the shared queue, DynamoDB, the NAT gateways) are allocated by a usage share that tracks what actually drives cost. For this product it's documents processed, not API calls, because the OCR workers dominate the bill.

```sql
-- Cost to serve per pool tenant, October 2026 (Athena)
WITH usage AS (
  SELECT tenant_id, SUM(quantity) AS docs
  FROM usage_events
  WHERE metric = 'documents_processed' AND month = '2026-10'
  GROUP BY tenant_id
),
total AS (SELECT SUM(docs) AS all_docs FROM usage),
pool_cost AS (
  SELECT SUM(line_item_unblended_cost) AS cost
  FROM cur2
  WHERE billing_period = '2026-10'
    AND line_item_usage_account_id = '111122223333'   -- pool account
)
SELECT u.tenant_id,
       u.docs,
       ROUND(p.cost * u.docs / t.all_docs, 2) AS allocated_cost
FROM usage u CROSS JOIN total t CROSS JOIN pool_cost p
ORDER BY allocated_cost DESC
LIMIT 50;
```

The first time this query ran, the top of the list was a surprise. One Basic tenant on a $490 per month seat-based plan was processing 3.1% of all documents in the pool. With a pool cost of $61,000 that month, its allocated cost was $1,891 plus $340 of direct storage and KMS cost: **a cost to serve of $2,231 and a gross margin of minus 355%**. Six other Basic tenants were losing money too. The fix wasn't technical: Basic moved to pricing on documents processed with a seat minimum, and bulk imports above the daily quota became a paid add-on.

### Billing

For tenants who buy through AWS Marketplace, the metering service reports usage with `BatchMeterUsage` hourly, with the customer identifier stored in the tenant registry at sign-up. Everyone else is billed from the same hourly usage table by the provider's own billing system. Either way the number on the invoice and the number in the cost report come from the same events, which ends the "why does finance's number not match engineering's" meetings.

## Onboarding automation

The top half of the same diagram is onboarding. One Step Functions state machine, two paths.

**Pool path (Basic and Pro), about 40 seconds.** Create the tenant record, create the Cognito group or register the customer's SAML IdP, create the first admin user, attach an API key to the tier's usage plan, seed configuration in AppConfig, and for Pro create the tenant database, its KMS key, and commit a `pro-<tenant>` namespace to the GitOps repository so Argo CD creates the namespace, quota, network policy and worker deployment. Then publish `TenantOnboarded`.

**Silo path (Enterprise), about 90 minutes, no human steps.**

1. **Account Factory** creates an account in the `SaaS-Silo` OU, with the guardrails of that OU applied from the first second. Account vending is the slowest step. Ask for an increase to the Organizations account quota well before you need it, because a new enterprise customer waiting on a quota ticket is a bad first week.
2. **StackSets** apply the baseline: IAM roles for the pipeline and for support access, CloudTrail to the central log archive, Config, GuardDuty, and the VPC with PrivateLink endpoint service.
3. **The deployment pipeline** deploys the application stack at the *same version as the pool*, with the tenant's region, its key ARN and its IdP metadata as parameters.
4. **Smoke and isolation tests** run from outside: sign in, upload a document, check it's processed, and check that a token from another tenant is refused.
5. **`TenantOnboarded`** is published. The registry records the account id and endpoint, metering subscribes, the customer gets the admin invite.

Offboarding is the same machine in reverse, and deserves the same care: suspend the tenant, export its data to a location it chooses, wait out the contractual retention period, then delete its data and schedule deletion of its keys. For a Pro tenant that means dropping one database and one key; for a silo, closing the account. Keep the evidence, because customers' auditors will ask.

### acme-bank, from contract to production

Here's how the enterprise requirements from the start of the article mapped onto that workflow:

| Requirement | How it was met |
|---|---|
| EU only, not shared | Silo account in `eu-central-1`, SCP denying all other regions on the `SaaS-Silo` OU |
| Bank-controlled key | Key in the bank's account, key policy granting the silo's application role; ARN passed as a pipeline parameter |
| No public endpoint | Private REST API reached through a VPC endpoint in the bank's VPC over PrivateLink |
| SSO with their IdP | SAML IdP registered in Cognito by the onboarding workflow from the metadata URL they supplied |
| Daily audit export | A scheduled job copies the tenant's CloudTrail and application audit log to the bank's bucket, using a bucket policy the bank wrote |
| 99.95% availability | Three AZs, Aurora with a reader in another AZ, separate maintenance window in the tier config |
| Annual pen test | Allowed against their own silo only, which is the cleanest answer you can give an enterprise security team |

Contract signed on a Tuesday afternoon; the silo was live and tested 94 minutes after the onboarding request was submitted, and the bank's own integration testing started the next morning. Before this workflow existed, the previous enterprise customer had waited three weeks.

### Deploying to pools and silos without drift

The pipeline deploys in waves: an internal canary tenant, then the pool in one region, then the other region, then the silos in batches, with automatic rollback on alarms at each step. Silos are never more than one release behind the pool; a customer can choose its window, not its version. That rule is what keeps "ten silo accounts" from turning into "ten different products."

## Mapping to the Well-Architected Framework

The [SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html) adds SaaS-specific questions to the six pillars of the [Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html). This is how the design answers them.

| Pillar | Decisions in this design |
|---|---|
| Operational excellence | One pipeline deploying in waves to pool and silos; onboarding and offboarding as a state machine; tenant-aware logs, metrics and traces; tenant health dashboard in the control plane |
| Security | Tenant context from the IdP, verified by the authorizer; tenant-scoped credentials with session tags; LeadingKeys, S3 prefix and KMS encryption-context conditions; Postgres RLS; per-tenant keys for Pro; customer-owned keys and account isolation for Enterprise; alarms on cross-tenant denials; isolation tests in every release |
| Reliability | Per-tenant limits at every shared layer so one tenant can't exhaust capacity; separate bulk and interactive lanes; silos isolate enterprise tenants' failure domains; multi-AZ everywhere; home region per tenant |
| Performance efficiency | Pool shares capacity across 1,640 tenants; KEDA and Karpenter scale workers on queue depth; write sharding for hot tenants; fair queues keep latency flat for quiet tenants |
| Cost optimisation | Model per tier priced above its cost floor; Graviton and Spot; cost per tenant from usage events, split cost allocation and silo tags; pricing changed when the data showed loss-making plans |
| Sustainability | Pooling keeps utilisation high instead of hundreds of idle per-tenant stacks; Graviton; bulk work runs on Spot capacity that would otherwise be idle |

## Production-readiness checklist

- [ ] Every tier has a defined deployment model (pool, bridge or silo) and a cost floor below its price.
- [ ] The tenant registry is the single source of truth for tier, region, status and silo endpoints.
- [ ] Tenant claims in the IdP can only be written by the control plane.
- [ ] Services read the tenant id only from the authorizer context, never from client input.
- [ ] Data access uses tenant-scoped credentials. No tenant role allows `Scan` or bucket-wide access.
- [ ] Shared Postgres tables have `FORCE ROW LEVEL SECURITY`, and the app role isn't the owner and lacks `BYPASSRLS`.
- [ ] Cross-tenant `AccessDenied` is a metric with an alarm, and isolation tests run on every release and every new silo.
- [ ] Every shared resource has a per-tenant limit, and bulk work has its own queue and workers.
- [ ] Per-tenant metrics exist for the top tenants, and an alarm fires when one tenant dominates a shared resource.
- [ ] Usage events include `tenant_id` and are joined with CUR 2.0 monthly to produce cost and margin per tenant.
- [ ] Onboarding and offboarding for every tier are automated end to end, including silo account vending.
- [ ] Silos are deployed by the same pipeline as the pool and are never more than one release behind.

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the tiers, regions and limits to match your product.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-multi-tenant-saas/aws-multi-tenant-saas.drawio)
- [Reference architecture: control plane, pool and silo](/assets/diagrams/aws-multi-tenant-saas/saas-reference.drawio)
- [Tenant context and isolation on every request](/assets/diagrams/aws-multi-tenant-saas/saas-tenant-context.drawio)
- [Noisy-neighbour controls, layer by layer](/assets/diagrams/aws-multi-tenant-saas/saas-noisy-neighbor.drawio)
- [Onboarding automation and per-tenant metering](/assets/diagrams/aws-multi-tenant-saas/saas-onboarding-metering.drawio)

Tenant counts, limits, latencies, costs and timings are examples from one product. Check current quotas, prices and regional availability for your own regions before you build.

## References

- [AWS Well-Architected SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html)
- [SaaS Lens: silo, pool and bridge models](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html)
- [SaaS Lens: preventing cross-tenant access](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/preventing-cross-tenant-access.html)
- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [Guidance for multi-tenant architectures on AWS](https://docs.aws.amazon.com/solutions/multi-tenant-architectures-on-aws/)
- [How to implement SaaS tenant isolation with ABAC and AWS IAM](https://aws.amazon.com/blogs/security/how-to-implement-saas-tenant-isolation-with-abac-and-aws-iam/)
- [Grant Pods access to AWS resources based on tags (EKS Pod Identity)](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-abac.html)
- [Usage plans and API keys for REST APIs in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html)
- [Building resilient multi-tenant systems with Amazon SQS fair queues](https://aws.amazon.com/blogs/compute/building-resilient-multi-tenant-systems-with-amazon-sqs-fair-queues/)
- [Lambda tenant isolation mode (TenancyConfig)](https://docs.aws.amazon.com/lambda/latest/api/API_TenancyConfig.html)
- [Understanding split cost allocation data](https://docs.aws.amazon.com/cur/latest/userguide/split-cost-allocation-data.html)
- [AWS Marketplace metering for SaaS usage](https://docs.aws.amazon.com/marketplace/latest/userguide/metering-for-usage.html)
- [SaaS Builder Toolkit for AWS](https://github.com/awslabs/sbt-aws)
