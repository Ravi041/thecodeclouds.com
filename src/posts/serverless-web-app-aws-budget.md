---
title: "A serverless web app on AWS for about $20 a month: architecture, cost math and the guardrails that keep it there"
description: "A startup-sized reference architecture on AWS with CloudFront, S3, API Gateway, Lambda, DynamoDB and Cognito. Clear requirements, line-by-line cost math at 5,000 and 50,000 users, a TV-feature traffic spike, a denial-of-wallet bug, and how each decision maps to the AWS Well-Architected Framework. Three editable draw.io diagrams."
date: 2026-11-21T03:01:00Z
category: Cloud & DevOps
coverLabel: "Serverless on\nAWS for about\n$20 a month."
coverCode: "CloudFront → HTTP API → Lambda → DynamoDB"
coverLogos: "aws"
coverImage: /assets/images/covers/serverless-web-app-aws-budget.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Serverless on AWS for about $20 a month.', with the AWS logo."
---
Most early-stage teams I talk to want the same three things from their first AWS bill: small, predictable, and not a reason to wake up at 3 a.m. They don't have an ops person. Their traffic is close to zero most of the week and then, without warning, it isn't: a newsletter mention, a launch on a community site, a two-minute segment on breakfast TV.

This article is the architecture I'd hand a two-person team in that position. It's fully serverless, it runs in one AWS Region, and at launch size it costs about **$20 a month** on list prices. More useful than the headline number: I'll show where every dollar comes from, what changes at ten times the users, which line item quietly becomes the biggest one, and the six settings that stop a bad day from turning into a bad invoice.

This is the first article in a series on AWS architectures for specific problems. Each one starts from written requirements, shows the design, does the math, and maps the decisions to the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html).

## The short version

- **Pay per request, not per hour.** CloudFront, S3, an API Gateway HTTP API, Lambda on Arm and DynamoDB on-demand. Nothing runs, and nothing bills, while nobody is using the app.
- **No VPC, so no NAT gateway.** Nothing in this design needs private networking. Skipping it removes the single most common "why is my idle bill $40?" line.
- **One domain, one CDN.** CloudFront serves the single-page app from S3 and forwards `/api/*` to the HTTP API. No CORS, one WAF, one certificate.
- **Cognito is your biggest bill at scale, not Lambda.** At 50,000 monthly active users it's more than half the total. Pick the Lite feature plan unless you need what Essentials adds.
- **Put a ceiling on every layer.** WAF rate rules, API Gateway throttles, Lambda reserved concurrency and DynamoDB on-demand maximum throughput. Budgets alert you; throttles actually stop spending.
- **Expected bill:** about $20 a month at 5,000 users, about $380 a month at 50,000 users, and about $80 for the day the TV crew turns up.

## The requirements

Architecture without requirements is just a list of services. Here's the brief this design answers. The example product is a meal-planning web app: people save recipes, plan their week and share a shopping list.

### Functional

| # | Requirement |
|---|---|
| F1 | Single-page web app served on the company's own domain over HTTPS |
| F2 | Sign up and sign in with email and password, plus Google sign-in |
| F3 | Create, read, update and share meal plans and recipes through a JSON API |
| F4 | Upload recipe photos (up to 5 MB) and show thumbnails |
| F5 | Send an opt-in weekly digest email on Sunday evening, in each user's time zone |

### Non-functional

| # | Requirement | Target |
|---|---|---|
| N1 | Cost at launch (5,000 monthly active users) | Under $50 a month, all-in |
| N2 | Cost at growth (50,000 monthly active users) | Under $1 per 100 MAU per month |
| N3 | Spiky traffic | Absorb 50x the normal peak for a few hours with no manual action |
| N4 | API latency | p95 under 300 ms for reads, measured at the edge |
| N5 | Availability | 99.9% monthly for sign-in and the API |
| N6 | Data protection | RPO 15 minutes, RTO 4 hours, encryption at rest and in transit |
| N7 | Operations | Two engineers, no on-call rota, deploy from CI several times a day |
| N8 | Security | No long-lived access keys, least-privilege roles, OWASP top-ten protections at the edge |

### Constraints and assumptions

- One AWS Region (us-east-1 in the examples). Users are mostly in North America and Europe; CloudFront brings the static content close to both.
- The team writes TypeScript, so functions run on Node.js 22.
- The traffic model behind every number below: each daily active user opens the app twice a day; a session loads about 0.9 MB of HTML, scripts and images (around 12 CloudFront requests once the browser cache is warm) and makes 25 API calls averaging 3 KB. Each API call runs one Lambda invocation of about 80 ms at 512 MB, reads about 2 and writes about 0.4 DynamoDB request units.

If your numbers differ, the method still holds. The calculator I used is in the downloads at the end.

## The architecture

<figure class="diagram wide"><a href="/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-architecture.svg" title="Open the full-size diagram"><img src="/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-architecture.svg" alt="Serverless reference architecture in us-east-1 with no VPC. Users resolve app.example in Route 53 (step 1), an alias to a CloudFront distribution (step 2) with an AWS WAF web ACL and a free ACM certificate attached. CloudFront serves the default path from a private S3 site bucket through origin access control (step 3) and forwards /api/* to an API Gateway HTTP API (step 4) with a JWT authorizer and stage and route throttling; only GET /api/public/* is cached for 60 seconds. The HTTP API invokes API functions on Lambda, Node.js 22 on arm64 with 512 MB and reserved concurrency 300 (step 5), which use a single DynamoDB table in on-demand mode with maximum throughput set and point-in-time recovery (step 6). Users sign in to a Cognito user pool on the Lite plan (step 7), and the HTTP API validates the JWTs it issues. Browsers upload photos directly to an S3 uploads bucket with a presigned POST capped at 5 MB (step 8); an event on the raw/ prefix triggers a thumbnail function with reserved concurrency 20 that marks the photo ready in DynamoDB. A weekly digest runs off the request path: EventBridge Scheduler on Sunday at 17:00 per time zone triggers a fan-out function that queries opted-in users, sends batches to an SQS queue with a dead-letter queue, and a send function with maximum concurrency 5 sends through Amazon SES. An operations band shows CloudWatch with JSON logs, 14-day retention and eight alarms, X-Ray at 5 percent sampling, AWS Budgets with Cost Anomaly Detection alerting at 60 dollars a month, Parameter Store SecureString parameters on the free standard tier, KMS with AWS managed keys, and infrastructure as code with AWS SAM or CDK deployed from CI using OIDC." width="1500" height="900" loading="lazy"></a><figcaption>The whole system. Numbers match the walkthrough below.</figcaption></figure>

1. **Route 53** hosts the zone. The apex and `www` are alias records to CloudFront, and alias queries to CloudFront are free, so DNS costs the $0.50 hosted-zone fee and nothing else.
2. **CloudFront** is the only public entry point. It terminates TLS with a free [ACM](https://docs.aws.amazon.com/acm/latest/userguide/acm-overview.html) certificate (issued in us-east-1, which CloudFront requires) and has an AWS WAF web ACL attached.
3. **The S3 site bucket is private.** CloudFront reads it with [origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), and Block Public Access stays on. Build output uses content-hashed file names with a one-year cache TTL; only `index.html` gets a short TTL, so a deploy is live within a minute without an invalidation.
4. **An HTTP API, not a REST API.** HTTP APIs cost $1.00 per million requests against $3.50 for REST APIs, and they have a built-in [JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) that validates Cognito tokens without a Lambda authorizer. The REST API features you give up (usage plans and API keys, request validation, per-method caching, direct WAF association) aren't needed here: WAF sits on CloudFront instead.
5. **A few Lambda functions, grouped by domain.** One function each for plans, recipes and uploads, not one per route. That keeps cold starts rarer and deployments simpler. They run on **arm64 (Graviton)**, which AWS prices about 20% lower per GB-second than x86, with **512 MB** of memory, and **outside any VPC** because they only call AWS APIs.
6. **DynamoDB on-demand, single table.** Partition key `PK` (`USER#id`, `PLAN#id`, `RECIPE#id`) and sort key `SK`, plus one GSI for the digest. On-demand bills per request and nothing when idle. [Point-in-time recovery](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html) and deletion protection are on.
7. **Cognito user pool on the Lite plan.** Email and password plus Google federation through the user pool. The free tier for Lite and Essentials is 10,000 MAU per month for direct and social sign-in, and it doesn't expire after the first year.
8. **Photos go straight to S3.** The uploads function returns a [presigned POST](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html) whose policy pins the key prefix to the caller and limits size with `content-length-range`. The browser uploads directly to S3; Lambda never handles the bytes, so a 5 MB photo costs one S3 PUT, not five seconds of function time.

### Why not containers or a small EC2 instance?

Because of the idle bill. A minimal always-on container setup in one Region (an Application Load Balancer, two small Fargate tasks across two AZs, a NAT gateway so they can reach the internet, a small Multi-AZ database and a couple of public IPv4 addresses) lands somewhere around $100 to $130 a month before the first user signs up, by my rough count from the public price lists. That's five or six times this design's launch bill. Containers win later, when traffic is steady and high enough that paying per hour beats paying per request. For a product that might have 40 users on a Tuesday, it's the wrong trade.

The honest costs of going serverless: cold starts (covered below), the HTTP API's 30-second integration timeout, a 6 MB synchronous Lambda payload limit (which is why uploads go direct to S3), and the need to model DynamoDB access patterns up front.

## The cost math, line by line

All prices are us-east-1 list prices on AWS pricing pages as of November 2026, without Savings Plans or credits. The "always-free" column applies only the free tiers that don't expire: Lambda's 1 million requests and 400,000 GB-seconds, CloudFront's 1 TB and 10 million requests, DynamoDB's 25 GB of storage, CloudWatch Logs' 5 GB and Cognito's 10,000 MAU. I left out the 12-month API Gateway free tier on purpose: plan for the month it ends.

### Launch: 5,000 MAU, 1,500 daily users

That's 90,000 sessions, 2.25 million API calls, 3.3 million CloudFront requests and 88 GB of transfer a month.

| Line item | How it's calculated | List price | With always-free tiers |
|---|---|---|---|
| CloudFront | 88 GB × $0.085 + 3.33M requests × $0.01 per 10,000 | $10.79 | $0.00 |
| AWS WAF | $5 web ACL + 4 rules × $1 + 3.33M × $0.60 per million | $11.00 | $11.00 |
| API Gateway HTTP API | 2.25M × $1.00 per million | $2.25 | $2.25 |
| Lambda (arm64) | 2.25M requests × $0.20/M + 90,000 GB-s | $1.65 | $0.25 |
| DynamoDB | 4.5M reads × $0.125/M + 0.9M writes × $0.625/M + 3 GB storage + PITR | $2.48 | $1.73 |
| S3 | 25 GB of photos + uploads and origin requests | $0.68 | $0.68 |
| Cognito (Lite) | 5,000 MAU, all inside the 10,000 free | $0.00 | $0.00 |
| Route 53 | one hosted zone | $0.50 | $0.50 |
| CloudWatch | 4.5 GB of logs + 8 alarms × $0.10 | $3.05 | $0.80 |
| SES | 20,000 digest emails × $0.16 per 1,000 | $3.20 | $3.20 |
| **Total** | | **$35.59** | **$20.40** |

Two things stand out. WAF is the single biggest line at launch: the $9 of fixed monthly fees don't care how small you are. And everything that scales with usage (API Gateway, Lambda, DynamoDB) adds up to under $5.

### Growth: 50,000 MAU, 15,000 daily users

Ten times the users: 22.5 million API calls, 33.3 million CloudFront requests, 878 GB of transfer.

| Line item | Monthly |
|---|---|
| CloudFront (after the free 1 TB and 10M requests) | $23.30 |
| AWS WAF | $28.98 |
| API Gateway HTTP API | $22.50 |
| Lambda (arm64) | $10.97 |
| DynamoDB (on-demand + 30 GB with PITR) | $18.50 |
| S3 (250 GB) | $6.79 |
| **Cognito Lite: 40,000 MAU over the free tier × $0.0055** | **$220.00** |
| Route 53 | $0.50 |
| CloudWatch (45 GB of logs + alarms) | $20.80 |
| SES (200,000 emails) | $32.00 |
| **Total** | **$384.33** |

That's $0.77 per 100 MAU, inside requirement N2. But look at the bold line: **identity is 57% of the bill**. Compute, the thing people worry about, is under 3%.

If the team had accepted the default feature plan for new user pools, Essentials at $0.015 per MAU above the free tier, the Cognito line would be $600 and the total $764. Essentials adds real features (the newer managed login pages, passwordless sign-in with one-time codes, passkeys, email MFA, access-token customisation), and some products need them. Just choose it on purpose. The [feature plans page](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html) lists exactly what each tier includes.

### Four cheap optimisations at growth size

1. **Log less, keep it shorter.** Log at `WARN` in production with a sampled `DEBUG` rate, set 14-day retention, and use the Infrequent Access log class for anything you only query during incidents. Cutting volume by 70% takes CloudWatch from $20.80 to about $7.50.
2. **Cache public reads at the edge.** Recipe pages that don't depend on the user can be `GET /api/public/*` with a 60-second TTL. If that absorbs 30% of API calls, API Gateway, Lambda and DynamoDB together drop by about $12.
3. **Check your Lambda memory with real data.** [AWS Lambda Power Tuning](https://docs.aws.amazon.com/lambda/latest/operatorguide/profile-functions.html) often finds that more memory finishes faster and costs the same or less. Don't guess.
4. **Look at the CloudFront flat-rate plans.** The [Pro plan](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) is $15 a month for 10 million requests and 50 TB, and bundles WAF, DDoS protection, Route 53 DNS, CloudWatch Logs ingestion and the TLS certificate, with no overage charges. At launch size (3.3M requests) it costs a few dollars more than pay-as-you-go, but it turns the edge into a fixed cost, which matters for the second scenario below. At growth size you're past its allowance, and pay-as-you-go is cheaper than the $200 Business plan.

## Six ceilings: absorbing a spike without a surprise bill

Serverless scales on its own. That's the selling point, and it's also the risk: the same automatic scaling that absorbs a real spike will happily absorb a bug or a bot, and bill you for it. The fix is to decide, for each layer, how much is too much.

<figure class="diagram wide"><a href="/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-guardrails.svg" title="Open the full-size diagram"><img src="/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-guardrails.svg" alt="Six guardrails along the request path from visitors to AWS WAF, CloudFront, the HTTP API, Lambda and DynamoDB, with sign-up and sign-in going straight to Cognito. Example spike: a TV feature sends 80,000 sessions in 3 hours, a peak of about 740 API requests per second, about 90 concurrent Lambda environments and 35 sign-ups per second for two minutes. 1, WAF: a rate-based rule of 1,000 requests per 5 minutes per IP plus AWS managed core rule set, known bad inputs and IP reputation; blocked requests never reach API Gateway or Lambda. 2, CloudFront: SPA and images with a one-year TTL and hashed file names, GET /api/public/* with a 60-second TTL. 3, HTTP API: stage throttle of 1,000 requests per second steady with a burst of 2,000, a route throttle of 200 per second on PUT /plans, against an account default of 10,000; clients get 429 and retry with jitter. 4, Lambda: reserved concurrency 300 for API functions, 20 for thumbnails and 5 for sending email; the account default is 1,000 and each function scales by 1,000 environments every 10 seconds; peak needed about 90. 5, DynamoDB: on-demand maximum throughput of 2,000 writes and 6,000 reads per second; new on-demand tables sustain 4,000 writes and 12,000 reads per second and double the previous peak; peak needed about 300 write units per second. 6, Cognito: UserCreation quota 50 requests per second and UserAuthentication 120, both adjustable, so raise them before a planned launch; Lite plan has 10,000 MAU free then 0.0055 dollars per MAU. Below, a band of cost signals: CloudWatch alarms on 4XX and 5XX rate, Lambda throttles and p95 latency, AWS Budgets at 60 dollars a month alerting at 50, 80 and 100 percent plus forecast, and Cost Anomaly Detection with a per-service monitor, all notifying an SNS topic for email and chat. Budget and anomaly alerts lag by hours; CloudWatch alarms on request rate catch a runaway loop in minutes. Budget alerts do not stop spending; the throttles do." width="1500" height="760" loading="lazy"></a><figcaption>Every layer gets an explicit limit sized from the traffic model, well above the expected peak and far below the account defaults.</figcaption></figure>

The numbers that matter, and where they come from:

| Layer | Setting in this design | Expected peak | AWS default |
|---|---|---|---|
| AWS WAF | Rate-based rule: 1,000 requests per 5 min per IP | ~300 per 5 min for a busy human | No limit until you add one |
| API Gateway | Stage 1,000 req/s, burst 2,000; route limits on writes | ~740 req/s on the TV day | 10,000 req/s per account per Region, burst 5,000 ([quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)) |
| Lambda | Reserved concurrency 300 (API), 20 (thumbnails), 5 (email) | ~90 concurrent | 1,000 per account per Region; each function scales by 1,000 environments every 10 seconds ([scaling](https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html)) |
| DynamoDB | [On-demand maximum throughput](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode-max-throughput.html): 2,000 writes/s, 6,000 reads/s | ~300 writes/s, ~1,500 reads/s | New on-demand tables sustain 4,000 writes/s and 12,000 reads/s, then double the previous peak |
| Cognito | Quota increase requested a week before planned launches | 35 sign-ups/s for two minutes | UserCreation 50 req/s, UserAuthentication 120 req/s, both adjustable ([quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html)) |
| Billing | Budget of $60/month; Cost Anomaly Detection on every service | | Nothing until you set it |

Lambda's reserved concurrency does two jobs: it caps how many copies of a function can run at once, and it guarantees that the thumbnail function can never starve the API of concurrency. Keep in mind that the account's 1,000 is shared by every function in the Region, including anything a teammate deploys next month.

## Uploads and email, off the request path

<figure class="diagram wide"><a href="/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-async.svg" title="Open the full-size diagram"><img src="/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-async.svg" alt="Two asynchronous flows. A, recipe photo upload: the browser calls POST /api/uploads with a JWT (step 1); the uploads function signs a presigned POST whose policy limits content-length-range to 1 byte to 5 MB, requires a Content-Type starting with image/ and fixes the key to the caller's prefix (step 2); the browser posts the form straight to the S3 uploads bucket at raw/userId/uuid.jpg, valid for 5 minutes (step 3); an ObjectCreated event filtered to the raw/ prefix triggers the thumbnail function, arm64 with 1,024 MB and reserved concurrency 20, which writes to thumbs/, outside the trigger prefix so it cannot loop (step 4), and marks the photo ready on the recipe item in DynamoDB (step 5). Lifecycle moves raw/ to Intelligent-Tiering after 30 days and aborts incomplete multipart uploads after 1 day. B, weekly digest for 50,000 emails: EventBridge Scheduler with one cron schedule per time zone at 17:00 on Sunday triggers a fan-out function that queries a GSI for opted-in users in that time zone and sends batches of 50 user ids to an SQS queue with a 2-minute visibility timeout and maxReceiveCount 3. A send function reads plans from DynamoDB and sends through Amazon SES; its event source mapping has maximum concurrency 5, which keeps the send rate inside the SES quota. Failed batches retry, then land in a dead-letter queue with an alarm when it is not empty. Lambda and SQS cost cents; SES is about 8 dollars per 50,000 emails." width="1500" height="720" loading="lazy"></a><figcaption>Slow or bursty work goes through S3 events and SQS, with concurrency limits, so it can't compete with the API.</figcaption></figure>

Two details here have caught out real teams:

- **The thumbnail loop.** If a function triggered by `ObjectCreated` on a bucket writes its output back to the same prefix, it triggers itself. Filter the notification to `raw/` and write to `thumbs/`, or use a second bucket. Reserved concurrency of 20 limits the damage if someone gets it wrong.
- **The email burst.** A scheduler that fires once and sends 50,000 emails from one function will run into the SES sending rate and time out. Fan out through SQS and set [maximum concurrency](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html) on the event source mapping, so the queue drains at a rate SES accepts. Failed batches go to a dead-letter queue instead of retrying forever.

## Real scenarios, with numbers

### 1. The breakfast-TV segment

**What happened.** The founder gets four minutes on a morning show. Over the next three hours 80,000 people visit (normally it's 3,000 sessions a day) and 12,000 sign up.

**What the system did.** API traffic peaked around 740 requests per second, four times the three-hour average. With an 80 ms average and some slower writes, that's about 90 Lambda environments running at once: under a third of the reserved 300, and Lambda adds environments far faster than that. DynamoDB on-demand peaked near 300 write units per second, well under the 4,000 a new on-demand table handles on day one. CloudFront served the app shell and photos from cache, so the S3 origin saw a few thousand requests.

**What almost broke.** Sign-ups. In the two minutes after the segment, sign-up calls hit about 35 per second against Cognito's default of 50 for the UserCreation category. The team had asked for a quota increase the week before, because the producer had given them the date. If they hadn't, a slightly bigger audience would have turned into `TooManyRequestsException` on the sign-up form. Add client-side retries with jitter regardless.

**What it cost.** About $82 on top of the normal month, and $66 of that is the 12,000 new users counted as Cognito MAU. The 2 million extra API calls cost less than the sign-ups.

### 2. The polling bug (denial of wallet)

**What happened.** A frontend release polls `GET /api/plans/current` every second while a tab is open, instead of every 60 seconds. On Friday evening 2,000 people leave tabs open over the weekend.

**The math.** 2,000 tabs × 86,400 seconds is 172.8 million requests a day. Without limits that's roughly $173 of CloudFront requests, $173 of API Gateway, $104 of WAF requests, $127 of Lambda and $43 of DynamoDB reads: **about $620 a day**. Each tab makes 300 requests per 5 minutes, so the per-IP WAF rule at 1,000 never fires. These are real users.

**What contained it.** The stage throttle and a 100 req/s route limit on that path cut what reaches Lambda and DynamoDB by about 95%. But CloudFront and WAF still count every request, so the edge keeps billing around $280 a day. The thing that actually ended it was a CloudWatch alarm on CloudFront request count above three times the weekly baseline for 15 minutes. It fired 40 minutes after the release, the team shipped a fix, and the weekend cost about $30 instead of $1,800.

**Lesson.** Throttles protect the expensive back end; alarms protect the bill. AWS Budgets and Cost Anomaly Detection would have caught it too, but billing data lags by hours. If a predictable edge bill matters more to you than the last few dollars, this is exactly the case CloudFront's flat-rate plans are built for: no overage charges, and the doc says a first spike of up to three times the allowance doesn't affect service that month.

### 3. Cold starts on a quiet Tuesday

**What happened.** With 1,500 daily users spread across the day, many requests land on a function that hasn't run for minutes. The first request to a new execution environment pays the init cost: loading the runtime, your code and its dependencies.

**What helps, in order of cost.** Bundle and tree-shake with esbuild so the deployment package is a few hundred KB, not 30 MB of `node_modules`. Import only the AWS SDK v3 clients you use. Create clients outside the handler so they're reused. Stay out of a VPC. Group routes into a few functions so each stays warm more often. With those, cold starts land in the low hundreds of milliseconds for a typical Node.js function, and requirement N4 (p95 under 300 ms) holds because cold starts are a small fraction of requests.

**What I wouldn't do yet.** [Provisioned concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html) removes cold starts but bills every hour whether you use it or not, which is the opposite of this design. Measure p95 and p99 from CloudWatch first. If p99 matters to a specific route (checkout, say), provision a small number for that one function only.

### 4. The 2 GB "photo"

**What happened.** Someone scripts the upload endpoint, trying to use the bucket as free storage.

**What stops it.** The presigned POST policy caps size at 5 MB, pins the key to `raw/{userId}/`, requires an image content type, and expires after 5 minutes. The uploads function also checks a per-user counter in DynamoDB (50 uploads a day) before signing. The thumbnail function rejects anything that doesn't decode as an image and deletes it. The worst case is bounded: 50 × 5 MB a day per account, and creating accounts runs into Cognito, WAF and email verification.

## Mapped to the Well-Architected Framework

The framework's six pillars, and the [Serverless Applications Lens](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/welcome.html) that applies them to this kind of workload, are a useful checklist. Here's how this design answers each pillar.

| Pillar | Decisions in this design | How you'd know it's working |
|---|---|---|
| **Operational excellence** | Everything in AWS SAM or CDK, deployed from CI with an OIDC role ([no stored keys](/blog/workload-identity-federation-ci/)); structured JSON logs with request ids; alarms on symptoms (5XX rate, p95, throttles, DLQ depth) | Deploys take minutes and are routine; every alarm has an owner and a runbook line |
| **Security** | WAF managed rules and rate limits at the edge; private S3 with OAC; JWT authorizer on every non-public route; one IAM role per function with least privilege; secrets in Parameter Store SecureString; encryption at rest by default; presigned POST policies | No public bucket, no `*` actions in function roles (IAM Access Analyzer reports clean), WAF blocks in the logs |
| **Reliability** | Managed services that run across multiple AZs by default; SQS with a DLQ for async work; idempotent writes with conditional expressions; PITR for an RPO of seconds; IaC so the stack can be rebuilt in another Region (backup and restore DR, RTO in hours) | Monthly restore test of a PITR copy; DLQ empty; availability measured at CloudFront |
| **Performance efficiency** | CloudFront caching for static and public reads; HTTP API; Arm Lambda sized with Power Tuning; DynamoDB access patterns designed before the table | p95 under 300 ms at the edge; cache hit ratio above 90% for static paths |
| **Cost optimization** | Pay-per-request everywhere; no VPC or NAT; Arm; on-demand capacity; Cognito Lite; log retention and levels; Budgets plus anomaly detection; cost per 100 MAU as a tracked metric | Cost per 100 MAU stays under $1; no line item grows faster than users |
| **Sustainability** | Nothing idles: capacity follows demand; Graviton's better performance per watt; caching avoids repeat work; lifecycle rules tier old photos | Compute GB-seconds per active user flat or falling |

Where this design deliberately trades a pillar off: it's a single-Region deployment, so a full Region outage means hours of downtime while you restore elsewhere. For requirement N5 (99.9%, about 43 minutes a month) that's an acceptable risk at this stage. When the business needs more, the next step is DynamoDB global tables and a second Region behind CloudFront origin failover, which a later article in this series covers.

## When to move off this design

- **Steady high traffic.** When Lambda runs around the clock at high concurrency, containers on Fargate or EKS with Savings Plans become cheaper per request. Track cost per million API calls; when it stops falling, re-run the math.
- **Long or heavy requests.** Anything near the HTTP API's 30-second integration limit or Lambda's 15-minute maximum belongs in Step Functions, a queue, or a container.
- **Complex relational queries.** If the product grows into reporting and ad-hoc joins, add Aurora Serverless v2 for that part rather than forcing DynamoDB to do it.
- **Enterprise identity.** If customers want SAML single sign-on, Cognito charges SAML and OIDC federated users differently (the free tier is 50 MAU), so price it before you sell it.

## Launch checklist

- [ ] HTTP API with JWT authorizer, stage throttle and route limits on write paths
- [ ] Lambda on arm64, outside a VPC, reserved concurrency on every function, bundled with esbuild
- [ ] DynamoDB on-demand with maximum throughput, PITR and deletion protection
- [ ] Cognito Lite unless you need Essentials features; quota increase before any planned launch
- [ ] S3 buckets private with Block Public Access, CloudFront OAC, lifecycle rules
- [ ] WAF on CloudFront with managed rule groups and a rate-based rule
- [ ] Presigned POST with size, type and key-prefix conditions
- [ ] Async work through SQS with a DLQ and maximum concurrency
- [ ] Log retention set on every log group; production log level `WARN`
- [ ] CloudWatch alarms on request rate, 5XX, p95, throttles and DLQ depth
- [ ] AWS Budgets and Cost Anomaly Detection notifying a channel someone reads
- [ ] CI deploys with an OIDC role; no IAM users with access keys

## Download the diagrams

All three diagrams are editable `.drawio` files built with the AWS shapes that ship with draw.io, plus PNG exports for slides.

- [All three diagrams in one file (3 pages)](/assets/diagrams/serverless-web-app-aws-budget/serverless-web-app-budget.drawio)
- Reference architecture: [.drawio](/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-architecture.drawio) · [.png](/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-architecture.png)
- Spike and cost guardrails: [.drawio](/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-guardrails.drawio) · [.png](/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-guardrails.png)
- Uploads and weekly digest: [.drawio](/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-async.drawio) · [.png](/assets/diagrams/serverless-web-app-aws-budget/serverless-budget-async.png)
- [Cost calculator (Python, edit the traffic model and re-run)](/assets/diagrams/serverless-web-app-aws-budget/serverless-cost-model.py)

Prices are us-east-1 list prices from the AWS pricing pages in November 2026 and change over time; traffic figures are an example model, not measurements. Check the current pricing pages and quotas for your Region before you commit to a budget.

## References

- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [Serverless Applications Lens](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/welcome.html)
- [Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
- [Choosing between HTTP APIs and REST APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
- [Controlling access to HTTP APIs with JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- [Amazon API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)
- [Lambda scaling behavior](https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html)
- [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
- [Configuring maximum concurrency for SQS event sources](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)
- [DynamoDB on-demand capacity mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html)
- [DynamoDB on-demand maximum throughput](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode-max-throughput.html)
- [Amazon Cognito user pool feature plans](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html)
- [Amazon Cognito quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html)
- [Restricting access to an Amazon S3 origin (OAC)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [CloudFront flat-rate pricing plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)
- [AWS WAF rate-based rules](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html)
- [AWS Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html)
- Pricing pages: [Lambda](https://aws.amazon.com/lambda/pricing/), [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [DynamoDB](https://aws.amazon.com/dynamodb/pricing/), [CloudFront](https://aws.amazon.com/cloudfront/pricing/), [Cognito](https://aws.amazon.com/cognito/pricing/), [AWS WAF](https://aws.amazon.com/waf/pricing/), [Amazon SES](https://aws.amazon.com/ses/pricing/), [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/)
