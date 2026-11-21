---
title: "MLOps on AWS with SageMaker AI: pipelines, feature store, model registry and multi-account deployment for a fraud model"
description: "A production MLOps design for a real-time card fraud model on Amazon SageMaker AI: point-in-time features in Feature Store, a SageMaker Pipelines retrain with quality gates, Model Registry approval shared across accounts, blue/green canary deployment with auto-rollback, endpoint scaling sized from load tests, and drift monitoring built for labels that arrive 90 days late. Mapped to the Well-Architected ML Lens, with five production scenarios and four editable draw.io diagrams."
date: 2026-11-21T03:12:00Z
category: Cloud & DevOps
coverLabel: "Ship fraud models\nlike software,\nnot like notebooks."
coverCode: "p99 < 60 ms · 6,000 TPS · auto-rollback"
coverLogos: "aws"
coverImage: /assets/images/covers/sagemaker-mlops-fraud-detection.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Ship fraud models like software, not like notebooks.', with the AWS logo."
---
Most fraud models I've seen fail in production for reasons that have nothing to do with the model. The XGBoost was fine. What broke was a velocity feature computed one way in the training SQL and another way in the streaming job, a new version that went to 100% of traffic on a Friday afternoon, or a "drift dashboard" nobody looked at because the labels that would have proved the model was decaying arrived two months later.

This article is the MLOps platform I'd build around a real-time fraud model on AWS today with **Amazon SageMaker AI**: how features are produced and served, how a model gets trained, checked, approved and promoted across accounts, how the endpoint scales for a sale weekend, and how you notice it's getting worse before the chargebacks tell you. Everything is framed against the [Machine Learning Lens of the AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/machine-learning-lens/machine-learning-lens.html), and every service feature below was checked against the current AWS documentation in November 2026. Two of the services that older MLOps tutorials lean on, Model Monitor and Clarify, are no longer open to new customers, and the design reflects that.

There are four diagrams, each an editable `.drawio` file built with the official AWS shapes that ship with draw.io. At the end there are five production scenarios, with numbers, and what fixed each one.

## The short version

- **One account per stage.** Experimentation, ML tooling (pipelines and the registry), staging and production are separate AWS accounts. Production data and the scoring endpoint live together in the prod account.
- **One feature definition, two stores.** Streaming features are computed once (Managed Service for Apache Flink), written to the SageMaker Feature Store online store, and replicated to the offline store. Training reads the offline store with a point-in-time join, so training and serving can't disagree about what a feature means.
- **A retrain is a pipeline run, not a notebook.** SageMaker Pipelines builds the dataset, validates it, trains, evaluates against the current champion on the same test month, and only registers a candidate that wins.
- **A human approves, a pipeline deploys.** The Model Registry holds candidates as `PendingManualApproval`. Approval emits an EventBridge event that starts a CodePipeline, which deploys to staging, tests, waits for a manual gate and then updates prod.
- **New models meet real traffic gradually.** Blue/green deployment with 10% canary traffic, a baking period and CloudWatch alarms that roll back automatically, including a business alarm on decline rate.
- **Monitor for late labels.** Hourly input and score drift, daily precision from analyst reviews, monthly recall when chargebacks mature. Drift opens an investigation; it doesn't retrain on its own.
- **Size the endpoint from a load test.** Target tracking at 60% of the throughput where p99 latency broke, a faster second policy on a 10-second concurrency metric, and a scheduled floor for known peaks.

## The scenario

A card issuer scores every card-not-present authorisation for fraud before answering the card network. The numbers I'll use throughout:

| | Value |
|---|---|
| Authorisations | 1,500 per second on average, 6,000 per second at the Black Friday peak |
| Fraud rate | about 0.12% of transactions |
| Time the fraud check is allowed | 60 ms at p99, inside the issuer's overall authorisation budget |
| Model | gradient-boosted trees (XGBoost), about 180 features, retrained weekly |
| Labels | analyst review outcomes within 48 hours for alerted transactions; chargebacks mostly 30 to 90 days later |
| Alert budget | the fraud operations team can review about 0.5% of transactions |
| Regulation | PCI DSS scope for card data; model decisions must be explainable to a regulator for years |

The model is not the interesting part here. A good tabular model for this problem is well understood. The hard parts are latency, labels that arrive late, and being able to prove which model declined a customer's card on a given Tuesday.

## Requirements

Write these down before choosing services. Every design decision later traces back to one of them.

**Functional**

1. Score each authorisation with the current approved model and return a score, the top reasons, and the model version.
2. Use features that are seconds old (card velocity, device reuse) alongside daily ones (customer tenure, merchant risk).
3. Retrain weekly, and on demand when monitoring shows real change.
4. Promote a model to production only after automated checks and a named human approval.
5. Roll back to the previous model in minutes, without a redeploy of anything else.

**Non-functional**

| Requirement | Target | Why |
|---|---|---|
| Scoring latency | p99 under 60 ms end to end inside the risk service, endpoint p99 under 25 ms | The issuer has a fixed time to answer the network |
| Availability of scoring | 99.95%, with a rules-only fallback when the model is unavailable | An outage must degrade decisions, not block payments |
| Throughput | 6,000 scores per second at peak, with 50% headroom | Black Friday plus card-testing attacks |
| Reproducibility | Any production decision traceable to model version, training data snapshot, code commit and approver | Disputes and regulator questions |
| Model quality | Recall at the 0.5% alert budget no worse than the previous model; no customer segment worse by more than 2 points | Fraud loss and fairness |
| Security | No card numbers in features (tokens only), all ML storage encrypted with customer managed KMS keys, no public endpoints | PCI DSS and data protection |
| Cost | Inference under a fixed cost per million scores, reviewed monthly | It runs on every transaction |

## The architecture: accounts and flows

<figure class="diagram wide"><a href="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-multi-account.svg" title="Open the full-size diagram"><img src="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-multi-account.svg" alt="Multi-account MLOps architecture for fraud scoring. GitHub holds pipeline code, infrastructure as code and endpoint configuration; a merge to main starts the training pipeline. Data scientists work in an ml-dev account with SageMaker Studio on samples and an MLflow App shared from the tooling account through AWS RAM. The ml-tooling account runs SageMaker Pipelines (weekly retrain), training jobs (XGBoost on managed Spot), the Model Registry with a fraud-scorer model package group where new versions wait as PendingManualApproval, an MLflow App, ECR for inference and processing images, and an S3 bucket for model artifacts with SSE-KMS. When a version is approved, an EventBridge rule on Model Package State Change starts a CodePipeline deploy pipeline with a manual gate. CodePipeline deploys through CloudFormation to a staging endpoint in the fraud-staging account, where integration tests on replayed traffic, a load test to twice peak TPS, a p99 model latency check under 25 milliseconds and score parity with the offline evaluation run before prod. In the fraud-prod account, Kinesis Data Streams carries authorisation events to Managed Service for Apache Flink, which computes velocity features over 5 minutes, 1 hour and 24 hours and writes them with PutRecord to Feature Store online groups for card, device and merchant; Feature Store replicates them to an offline store in S3 with a Glue catalog. The offline store is shared read-only to the tooling account with a Lake Formation grant and a KMS key policy. A risk service called by payment authorisation reads the online store and invokes the fraud-scorer endpoint (6 to 30 ml.c7g instances across 3 AZs), which CodePipeline updates only with an approved version after the manual gate. Data capture, decisions and labels land in S3, a monitoring pipeline computes hourly drift and daily performance, and CloudWatch alarms on latency, errors, drift and decline rate notify on-call through SNS and can trigger retraining. Service control policies on every account forbid public endpoints, restrict regions, require KMS on ML storage and keep training and inference in a VPC with network isolation." width="1640" height="880" loading="lazy"></a><figcaption>Four accounts: experiments, tooling, staging and prod. Models move between them only through the registry and the deploy pipeline. Numbers match the list below.</figcaption></figure>

1. **Streaming features.** Authorisation events go to Kinesis Data Streams. A Managed Service for Apache Flink application computes velocity features (transactions per card in the last 5 minutes, amount in the last hour, cards seen on a device in 24 hours) and writes them to Feature Store online feature groups.
2. **Offline history.** Feature Store replicates every write to the offline store in S3 with a Glue Data Catalog table, keeping the full history with event times. That history is shared read-only with the tooling account.
3. **Training pipeline.** A SageMaker Pipelines DAG in the tooling account builds a point-in-time dataset, trains and evaluates. Every step logs to a SageMaker AI MLflow App.
4. **Registry.** A candidate that beats the champion is registered in the `fraud-scorer` model package group as `PendingManualApproval`.
5. **Approval starts deployment.** When a reviewer approves the version, the registry emits a *SageMaker Model Package State Change* event, and an EventBridge rule starts the deploy pipeline.
6. **Staging first.** CodePipeline deploys the same CloudFormation template to staging and runs the gates.
7. **Prod.** After a manual approval in the pipeline, the prod endpoint is updated with a blue/green canary deployment.
8. **Monitoring.** Captured requests, decisions and labels feed a monitoring pipeline whose results become CloudWatch metrics and alarms.

### Why this account split

The [ML Lens](https://docs.aws.amazon.com/wellarchitected/latest/machine-learning-lens/machine-learning-lens.html) and AWS's multi-account guidance both point the same way: the account is the cleanest boundary for blast radius, permissions and cost. For ML specifically:

- **ml-dev** is where people explore. It gets masked samples, not the full production history, so a notebook can't become a data leak.
- **ml-tooling** owns the things that must be consistent across stages: pipelines, the registry, container images, the MLflow App. It never serves traffic.
- **fraud-staging** is prod-shaped so that a load test means something.
- **fraud-prod** holds the endpoint *and* the production feature data. Keeping the online store in the same account as the scorer avoids a cross-account dependency on the hot path, and the docs note that when you share an online feature group with another account, the consumer's traffic counts against the owner's throughput limits. You don't want a training job's backfill competing with authorisations.

Cross-account sharing uses AWS RAM where SageMaker supports it. The [Model Registry supports cross-account sharing of model package groups](https://docs.aws.amazon.com/sagemaker/latest/dg/model-registry-ram.html), split into *discoverability* (other accounts can see the group) and *accessibility* (other accounts can register or deploy versions). Here, prod and staging get deploy access only. The MLflow App in tooling is shared to the dev account the same way. Feature Store also [supports sharing online feature groups through RAM](https://docs.aws.amazon.com/sagemaker/latest/dg/feature-store-cross-account-access-online-store.html), with read-only, read-write and admin access levels, though in this design we share the offline history through Lake Formation instead.

## Features: one definition, served online and replayed offline

Training-serving skew is the most common silent failure in fraud models, so the feature design comes first.

**Online store.** [Feature Store online store](https://docs.aws.amazon.com/sagemaker/latest/dg/feature-store-storage-configurations-online-store.html) now has three storage types:

| Type | What it gives you | Fit for this design |
|---|---|---|
| `Standard` | The default online store, with online and offline replication | Yes |
| `Standard_V2` | Adds `UpdateRecord`, so a writer can update only the features that changed, and rejects out-of-order writes by event time. Migrating from Standard is one-way | Good fit for the Flink writer, test before migrating |
| `InMemory` | Backed by Amazon ElastiCache (Redis OSS), supports list, set and vector types, default maximum size 50 GiB | Not here: it's online-only (no offline replication) and doesn't support customer managed KMS keys |

The InMemory tier is tempting for latency, but losing the offline history and customer managed keys breaks two requirements (reproducibility and encryption). For a fraud model the Standard tiers, read with `BatchGetRecord` for the card, device and merchant records in one call, through an interface VPC endpoint, fit inside a 10 ms budget in our tests. Measure your own; the docs don't publish latency numbers.

**Streaming writes.** Flink computes velocity features with event-time windows and writes them with the transaction's own timestamp as the record's event time. That detail matters: the offline store then contains exactly what the online store held at each moment.

**Point-in-time training data.** The dataset step uses the Feature Store dataset builder with a point-in-time accurate join: for each labelled transaction it picks the latest feature values *before* that transaction's timestamp. Without this, you train on features from the future (a card's 24-hour count that includes the fraud burst itself), the offline metrics look wonderful, and production recall disappoints.

**Labels.** A transaction is labelled fraud if it got a chargeback with a fraud reason code or an analyst confirmed it. Because chargebacks take up to about 90 days, the training window ends 90 days before the run date for "mature" labels. The last 90 days are only used for analyst-confirmed cases, so the model still learns new patterns quickly.

## The training pipeline

<figure class="diagram wide"><a href="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-training-pipeline.svg" title="Open the full-size diagram"><img src="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-training-pipeline.svg" alt="SageMaker Pipelines weekly retrain of the fraud model in the ml-tooling account, in private VPC subnets with network isolation on training. Three things start a run: EventBridge Scheduler on Sunday at 02:00 UTC, a merge to main that changes pipeline code, and a drift alarm after on-call confirms it. Step 1, BuildDataset, a Processing job, does a point-in-time join from the offline store shared read-only from fraud-prod: 18 months and 41 million transactions, with the label being a chargeback or confirmed fraud within 90 days. Step 2, ValidateData, checks schema, nulls, ranges, a fraud rate between 0.1 and 0.3 percent and drift against the last training set, and stops the run on failure. Step 3, Train, is an XGBoost training job on managed Spot with checkpoints and an out-of-time split: train up to month M-3, validate on M-2, test on M-1. Step 4, Evaluate, scores the candidate and the current champion on the same test month: recall at a 0.5 percent alert rate, PR-AUC and per-segment results. Step 5 is a condition: recall at budget at least 1 point better, no segment worse by more than 2 points, model size under 200 MB. If not, a Fail step logs the reason to MLflow, posts a Slack note and keeps the champion. If yes, step 6, Explain and fairness, computes SHAP global importance for the top 20 features and decline-rate parity by card type and country with pandas and scikit-learn; step 7, Baselines, writes feature histograms and the score distribution of the test month to S3 for the drift job; step 8, RegisterModel, creates a version in the fraud-scorer group with status PendingManualApproval and attaches metrics, the commit SHA, the dataset URI and the baseline URIs. Every step logs parameters, metrics and plots to an MLflow App, and the run ID is stored on the model version for lineage. A model risk reviewer reads the metrics, SHAP and fairness results and approves version 37, which changes its status to Approved and triggers EventBridge to start the deploy pipeline." width="1500" height="800" loading="lazy"></a><figcaption>The weekly retrain. A candidate reaches the registry only if it beats the champion on the same data, and it waits there for a person.</figcaption></figure>

The pipeline is defined in Python with the SageMaker Python SDK, lives in Git, and is upserted by CI on every merge. A few choices that matter more than they look:

- **Out-of-time evaluation.** Fraud patterns shift month to month, so a random split flatters the model. Train up to three months ago, tune on the month after, and test on the most recent month with mature labels.
- **Champion and challenger on the same test set.** The evaluation step loads the currently approved model from the registry and scores the same month. "PR-AUC 0.81" means nothing alone; "recall at our alert budget went from 62.4% to 64.1% and no segment got worse" is a decision.
- **The metric is operational.** The fraud team can review 0.5% of transactions, so the headline metric is recall at that alert rate, plus the dollar value of fraud caught. PR-AUC is reported but doesn't gate.
- **Spot training with checkpoints.** Managed Spot training with checkpointing cut the training cost of this job by roughly 60 to 70% in practice; the pipeline simply takes longer when capacity is short.
- **Explainability and fairness are computed in your own step.** SageMaker Clarify is [no longer open to new customers](https://docs.aws.amazon.com/sagemaker/latest/dg/clarify-availability-change.html); AWS's own guidance is to compute bias metrics directly with pandas and scikit-learn and use the open-source SHAP library, which is what Clarify used underneath. A Processing step does exactly that and writes the report next to the model.
- **Everything is logged to MLflow.** SageMaker AI now offers [serverless MLflow](https://aws.amazon.com/about-aws/whats-new/2025/12/sagemaker-ai-serverless-mlflow-ai-development/) as *MLflow Apps*: no tracking server to size, scaling to zero when idle, and shareable across accounts with RAM. Pipelines runs log parameters, metrics and artifacts there, and the MLflow run ID is stored on the registered model version.

### The registry and the approval

Every model version carries: approval status, the training job, the dataset S3 URI, the Git commit, evaluation metrics, the SHAP and fairness report, the baseline files used by monitoring, and the MLflow run ID. That set is what answers "why was this card declined" a year later.

New versions are registered as `PendingManualApproval`. A model risk reviewer, a different person from the data scientist who built it, approves in Studio or through the API. Approval is the *only* thing that can move a version toward production, and IAM enforces it: data scientists can register versions but not call `UpdateModelPackage` to approve them.

## The real-time scoring path

<figure class="diagram wide"><a href="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-scoring-path.svg" title="Open the full-size diagram"><img src="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-scoring-path.svg" alt="Real-time scoring path in the fraud-prod account in eu-west-1. A card network authorisation request reaches the authorisation service on ECS with Fargate (step 1), which calls the risk service with a 60 millisecond timeout (step 2). Inside a scoring VPC across three AZs with no internet egress, the risk service reaches AWS services through interface VPC endpoints for featurestore-runtime, runtime.sagemaker, kinesis-streams and monitoring. It calls BatchGetRecord on the Feature Store online store for card, device and merchant features (step 3) and invokes the fraud-scorer endpoint, XGBoost on ml.c7g.xlarge with a minimum of 6 and maximum of 30 instances across three AZs (step 4). It publishes authorisation and decision events to Kinesis Data Streams (step 5), which feeds Managed Service for Apache Flink computing streaming features such as card_txn_count_5m, amount_sum_1h and device_cards_24h; Flink writes them back to the online store with PutRecord, using the transaction time as event time. Endpoint scaling uses Application Auto Scaling: target tracking on SageMakerVariantInvocationsPerInstance at 18,000 per minute per instance, which is 60 percent of the 30,000 where p99 broke in load tests, a second policy on the 10-second ConcurrentRequestsPerModel metric, minimum 6 (two per AZ), maximum 30, scale-out cooldown 60 seconds and scale-in 600 seconds, and a scheduled action raising the minimum to 16 for the Black Friday weekend. Below, four S3 locations: the offline store with the same features as history for training, labels from chargebacks after 30 to 90 days and analyst reviews after 48 hours, data capture of 10 percent of endpoint requests, and a decisions table written by Firehose with every score and rule hit. A latency budget inside the risk service: receive and parse 2 ms, online features 10 ms, build vector 2 ms, endpoint 22 ms, rules and response 4 ms, total 40 ms with 20 ms headroom. A fallback: if the endpoint is slower than 35 ms or errors, use the rules-only policy, approve low-value transactions, step up the rest with 3-D Secure, emit a fallback_used metric, and alarm if more than 0.5 percent of traffic uses the fallback for 5 minutes." width="1500" height="840" loading="lazy"></a><figcaption>One authorisation, scored in about 40 ms at p99, with a defined fallback when the model can't answer in time.</figcaption></figure>

The risk service, not the endpoint, owns the decision. It fetches features, calls the model, applies business rules and thresholds (approve, step up with 3-D Secure, send to review, decline) and records the decision with the model version. Keeping thresholds outside the model lets the fraud team tighten the decline threshold during an attack without a model deployment.

**The latency budget.** Write it down per hop and alarm on each part separately: 2 ms to receive and parse, 10 ms for online features, 2 ms to build the vector, 22 ms for the endpoint call (the model itself takes about 3 ms; the rest is network, serialisation and queueing), 4 ms for rules and response. That's 40 ms at p99, leaving 20 ms of headroom. All AWS calls go through interface VPC endpoints, so there's no NAT gateway and no internet path on the hot path.

**The fallback.** If the endpoint doesn't answer within 35 ms, or returns an error, the risk service uses a rules-only policy and emits a `fallback_used` metric. A model outage then costs some precision for a few minutes, not authorisations. Practise this: block the endpoint in staging with AWS Fault Injection Service and check that the fallback really engages within the timeout.

### Sizing and scaling the endpoint

Start from a load test, not a guess. On the staging endpoint, ramp traffic until p99 model latency passes the 25 ms limit. In this scenario that happened at about 500 requests per second per `ml.c7g.xlarge` instance, or 30,000 invocations per minute. (Graviton instances work well for tree models; check that your inference container is built for arm64 before choosing them.)

The [auto scaling policy](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-policy.html) then follows:

- **Target tracking on `SageMakerVariantInvocationsPerInstance`** at 18,000 per minute, 60% of the breaking point. At the 1,500 TPS average (90,000 per minute) that's 5 instances; at the 6,000 TPS peak (360,000 per minute) it's 20.
- **Minimum 6, maximum 30.** Six gives two instances per Availability Zone, so losing a zone leaves four instances, enough for average load. SageMaker spreads instances across AZs when there's more than one; one instance is a single point of failure.
- **A second, faster policy.** The invocations metric is emitted once a minute. SageMaker also offers a [high-resolution concurrency metric, `SageMakerVariantConcurrentRequestsPerModelHighResolution`](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-add-code-define.html), emitted every 10 seconds, which reacts much sooner to a sudden burst. With two target tracking policies, Application Auto Scaling scales out if either asks for it.
- **Asymmetric cooldowns.** Scale out quickly (60 s), scale in slowly (600 s). The default is 300 seconds for both.
- **Scheduled scaling for known peaks.** Raise the minimum to 16 for the Black Friday weekend. Scheduled actions for SageMaker are managed through the CLI or the Application Auto Scaling API, not the console, so keep them in the same infrastructure code as the endpoint.
- **Quotas.** A blue/green deployment runs a full green fleet next to blue. At 20 instances that's 40 `ml.c7g.xlarge` endpoint instances for the duration of the deploy. Check the service quota before Black Friday, not during it.

Scale-to-zero exists, but only for endpoints that host inference components, and the first request after zero waits minutes for capacity. That's for dev endpoints and occasional batch use, never for a model on the authorisation path.

## Deployment: approved, tested, then canaried

<figure class="diagram wide"><a href="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-deploy-monitor.svg" title="Open the full-size diagram"><img src="/assets/diagrams/sagemaker-mlops/sagemaker-mlops-deploy-monitor.svg" alt="Deployment and monitoring loop. Top: a deploy pipeline in CodePipeline in the ml-tooling account, using cross-account roles into staging and prod, starts when version 37 is approved. Stages: Source (model package ARN plus endpoint config from Git), Staging (CloudFormation stack, same template as prod), Tests (replay 1 hour of traffic, load test at twice peak, score parity), Shadow in prod (24 hours, a copy of live traffic, compare score distributions), Manual approval (fraud operations lead and model risk), and Prod (UpdateEndpoint with blue/green, 10 percent canary and auto-rollback alarms). Middle: blue/green with canary traffic shifting on the prod endpoint fraud-scorer. The blue fleet runs version 36 on 6 to 30 ml.c7g.xlarge instances and goes from 100 to 90 to 0 percent; the green fleet runs version 37 at the same size and goes from 10 to 100 percent. Canary 10 percent for 15 minutes, then shift 100 percent and bake for 30 minutes, then done with blue terminated. If any alarm fires during canary or baking, all traffic goes back to blue. Rollback alarms in CloudWatch: Invocation5XXErrors above 0.1 percent, ModelLatency p99 above 25 milliseconds on green, decline rate above 1.3 times the 7-day baseline, and fallback_used above 0.5 percent. A note says Model Monitor and Clarify are no longer open to new customers, so the checks are your own Processing jobs using open-source drift libraries and SHAP, with results in CloudWatch, MLflow and QuickSight. Bottom: a monitoring pipeline of scheduled SageMaker Processing jobs in fraud-prod. Data capture and decisions feed an hourly drift job computing PSI on the top 20 features and the score, plus null and range checks against the training baseline. Labels from reviews and chargebacks feed a daily alert precision job using analyst outcomes after 48 hours and decline rate per segment, and a monthly true recall job using chargebacks matured at 90 days and fraud loss in basis points. All publish CloudWatch metrics in the FraudModel namespace with alarms; QuickSight shows a model health board and the MLflow App keeps monitoring runs per model version. When PSI exceeds 0.25 on three or more features for 6 hours, or precision drops by 5 points, SNS notifies on-call and the fraud ops channel. A retrain decision box says on-call checks the cause first (a data pipeline bug, an upstream schema change, or a real change in fraud patterns), only the last needs a new model, and then the training pipeline starts with a fresh window and the new version goes through every gate again." width="1500" height="860" loading="lazy"></a><figcaption>Top: approval to production with automatic rollback. Bottom: the monitoring loop that tells you when to start again.</figcaption></figure>

### The deploy pipeline

The EventBridge rule matches `SageMaker Model Package State Change` events for the `fraud-scorer` group where the new status is `Approved`, and starts a CodePipeline in the tooling account. CodePipeline assumes a deployment role in each target account and deploys one CloudFormation template (endpoint config, endpoint, scaling policy, alarms) with per-account parameters. If you started from SageMaker AI project templates, note that the AWS CodeCommit-based templates were removed in October 2024; [the current templates](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-projects-templates-sm.html) use third-party Git such as GitHub, and custom templates can now be stored in S3 instead of Service Catalog.

Stages, in order:

1. **Staging deploy and tests.** Replay one hour of recent production requests (from data capture) against staging, load test to twice peak TPS, and check *score parity*: the staging endpoint must produce the same scores as the evaluation step did offline, to six decimal places. Parity catches the classic packaging bugs, such as a different XGBoost version in the container or a feature in the wrong column order.
2. **Shadow in prod (for major changes).** [SageMaker shadow tests](https://docs.aws.amazon.com/sagemaker/latest/dg/shadow-tests.html) send a copy of live requests to the new variant while only the production variant's responses go back to callers. Run it for 24 hours and compare score distributions and how many transactions would cross each threshold. Skip it for a routine weekly retrain; use it for new features or a new algorithm.
3. **Manual approval.** A fraud operations lead approves in CodePipeline. They're accepting the operational impact (how many more alerts tomorrow), which is a different question from the model risk approval.
4. **Prod with deployment guardrails.**

### Blue/green with canary and auto-rollback

[Deployment guardrails](https://docs.aws.amazon.com/sagemaker/latest/dg/deployment-guardrails.html) on real-time endpoints give you blue/green updates with three traffic shifting modes (all at once, canary, linear) or rolling deployments. For a fraud model:

- **Canary 10% for 15 minutes**, then shift the rest and **bake for 30 minutes** before blue is terminated. The canary can be at most 50% of the green fleet's capacity.
- **Rollback alarms** in the `AutoRollbackConfiguration`: `Invocation5XXErrors`, `ModelLatency` p99 on the new endpoint config, and a business alarm on **decline rate** published by the risk service. A model can be perfectly healthy technically and still decline 2.5 times more good customers. Without alarms, the baking period can't roll anything back; the docs are explicit that auto-rollback depends on them.
- **Keep the variant name the same** across endpoint configs; guardrails require it.
- **Rehearse the update with auto scaling attached.** Run the same `UpdateEndpoint` in staging with the scaling policies in place, and check afterwards that the scalable target, both policies and the scheduled actions are still there, and how many instances green started with compared with blue's count at the time. Put that check in the pipeline so nobody verifies it by hand at release time.

Rollback to the previous model outside a deployment is just another deployment: approve the previous version again (or redeploy its endpoint config) and the same pipeline runs.

## Monitoring: drift now, accuracy later

Fraud models have an awkward feedback loop. You can measure *inputs* and *scores* immediately, analyst-reviewed alerts after about two days, and true recall only when chargebacks mature months later. The monitoring design has a job for each horizon.

**A note on Model Monitor.** If you read older SageMaker MLOps guides, they all use SageMaker Model Monitor for data quality, model quality, bias drift and feature attribution drift. As of the current documentation, [Model Monitor is no longer open to new customers](https://docs.aws.amazon.com/sagemaker/latest/dg/model-monitor-availability-change.html); existing customers can keep using it, but no new features are planned. AWS points new users to open-source monitoring solutions built on SageMaker AI MLflow Apps and Evidently AI, with CloudWatch and QuickSight. Endpoint **data capture** still works on its own: the docs say plainly that you don't need Model Monitor to capture request and response payloads. So the design below uses data capture plus your own scheduled jobs. If you're an existing Model Monitor customer, the same thresholds map onto its monitors.

| Job | Schedule | Inputs | Measures | Alarm |
|---|---|---|---|---|
| Drift | Hourly | Data capture (10% sample), training baselines | Population stability index (PSI) on the top-20 features and on the score; null rate and range checks | PSI above 0.25 on three or more features for 6 hours |
| Alert precision | Daily | Decisions, analyst outcomes after 48 h | Share of alerts confirmed as fraud; decline rate by segment | Precision down 5 points on the 7-day average |
| True recall | Monthly | Decisions, chargebacks matured at 90 days | Recall, fraud loss in basis points of volume | Recall below the champion's evaluation by 3 points |

Each job is a SageMaker Processing job started by EventBridge Scheduler. It writes metrics to a `FraudModel` CloudWatch namespace with the model version as a dimension, logs a run to MLflow, and refreshes a QuickSight model health board.

Data capture details worth knowing: capture is asynchronous, lands in S3 under endpoint, variant and hour prefixes, and stops capturing if the instance's disk passes about 75% use, so give the instances some disk headroom. Ten percent sampling is plenty at 1,500 TPS; that's still around 13 million rows a day.

**Drift doesn't retrain automatically.** An alarm pages on-call, who first checks the boring causes: a data pipeline bug, an upstream schema change, a merchant onboarding a new terminal type. Only a real change in fraud or customer behaviour needs a new model. Then the training pipeline runs with a fresh window, and the result goes through every gate again. Automatic retraining on drift sounds attractive until the drift was a broken feature and the pipeline happily trains a model on it.

## Security

- **No card numbers anywhere in ML.** The risk service sends tokens and derived features only. That keeps the ML accounts out of the most sensitive part of PCI DSS scope.
- **Network isolation.** Training and processing jobs run in private subnets with network isolation enabled where they don't need to call out; the endpoint is reached only through the `runtime.sagemaker` interface endpoint. A service control policy denies creating SageMaker resources without VPC configuration.
- **Encryption.** Customer managed KMS keys per data class (features, model artifacts, captured data), with key policies naming the roles that can decrypt. This is why the InMemory online tier, which doesn't support customer managed keys, was ruled out. See [envelope encryption with KMS](/blog/cloud-kms-envelope-encryption/) for why separate keys matter.
- **Least privilege by role.** Data scientists register model versions; only the model risk role approves; only the pipeline's deployment role updates prod endpoints. CI reaches AWS with OIDC, never access keys ([how and why](/blog/workload-identity-federation-ci/)).
- **Images.** Inference and processing images are built in CI, scanned in ECR, and referenced by digest in the endpoint config.
- **Audit.** CloudTrail in every account to the central log archive. The registry, MLflow run and Git commit together give lineage from a declined transaction back to the code.

## Cost

- **Inference is the bill.** At the average load of 1,500 TPS the endpoint sits around 6 to 7 instances, about 5,000 instance-hours a month. That baseline is a good fit for a SageMaker Savings Plan; the Black Friday peak stays on demand.
- **Right-size from the load test**, and re-run it when the model changes. A model with twice the trees can halve per-instance throughput.
- **Managed Spot for training**, with checkpoints.
- **Don't capture everything.** 10% data capture, S3 lifecycle rules to move capture data to cheaper storage classes after 30 days, and expire it after the retention period your regulator requires.
- **Shut down idle development resources.** Studio apps and dev endpoints left running are the classic ML waste. Lifecycle configurations that stop idle apps, and a budget alert per dev account, cost nothing.

## Mapping to the Well-Architected pillars

| Pillar | What this design does |
|---|---|
| Operational excellence | Pipelines as code; every model version traceable to data, code, metrics and approver; runbooks for drift and rollback; game days for the fallback |
| Security | Separate accounts, tokens instead of card data, VPC-only training and inference, customer managed keys, separation of duties between building, approving and deploying |
| Reliability | Multi-AZ endpoint with a minimum of two instances per AZ, a rules-only fallback, automatic rollback on alarms, staging load tests at twice peak |
| Performance efficiency | Latency budget per hop, online features read in one call over PrivateLink, Graviton instances sized from a load test, faster high-resolution scaling metric |
| Cost optimisation | Savings Plan for the baseline, Spot training, sampled data capture with lifecycle rules, scaled-down dev and staging |
| Sustainability | Right-sized Graviton instances, retraining when there's a reason plus a weekly cadence rather than daily, and no always-on capacity in dev |

## Five production scenarios

### 1. The velocity feature that meant two different things

**What happened.** A new model added `card_txn_count_1h`. Offline recall at the alert budget went up 4 points. In production, alert precision fell from 21% to 14% within a week.

**What the signals showed.** The hourly drift job flagged PSI of 0.41 on `card_txn_count_1h` against the training baseline on day one; the feature's production values were consistently lower. The training dataset had computed it with a SQL sliding window over settled transactions. The streaming job counted authorisations with a tumbling window, and declined authorisations weren't counted at all.

**What fixed it.** The feature was removed from the SQL and computed only in Flink, writing to the online store and therefore the offline store. Training now uses the offline store's history with a point-in-time join. The drift check on a new feature became a gate: a shadow test must show production PSI under 0.1 for new features before the manual approval.

### 2. Black Friday, minute one

**What happened.** At 00:00 traffic went from 1,800 to 5,400 TPS in under three minutes. Endpoint p99 went from 14 ms to 61 ms, the risk service hit its timeout, and 9% of authorisations used the rules-only fallback for six minutes.

**What the signals showed.** Target tracking on invocations per instance had asked for more instances, but the metric's one-minute period plus the time to launch instances meant the new capacity arrived after the spike had already hit.

**What fixed it.** A scheduled action now raises the minimum to 16 instances from the evening before. A second target tracking policy on the 10-second concurrency metric reacts to sudden bursts. And the staging load test now includes a step change from average to peak in 60 seconds, not just a slow ramp. The next peak ran at p99 18 ms with no fallback.

### 3. A card-testing wave the model hadn't seen

**What happened.** Fraudsters ran thousands of $1 authorisations through a newly onboarded merchant category to find valid cards. Score PSI barely moved; the model gave these small transactions low scores, so few were alerted.

**What the signals showed.** The daily precision job couldn't see it either, because the problem was transactions that *weren't* alerted. The signal came from the fraud operations team and from the decline rate dashboard by merchant category: approvals at that merchant category spiked 30x.

**What fixed it.** A rule in the risk service (velocity of small authorisations per merchant and BIN range) went live within an hour, without touching the model. Analyst labels from the attack fed the next retrain, which added a merchant-level velocity feature. The lesson: monitoring by segment and the rules layer are part of the ML system. Drift on aggregate inputs won't catch every attack.

### 4. The new model that declined good customers

**What happened.** Version 41 passed every offline gate. Ten minutes into the 10% canary, the decline rate on green traffic was 2.4 times the baseline.

**What the signals showed.** The decline rate alarm fired and deployment guardrails rolled all traffic back to blue automatically. Total impact: about 10% of traffic for 11 minutes. Investigation found a calibration shift; the model's scores were higher across the board, so the unchanged decline threshold caught more good transactions.

**What fixed it.** The evaluation step now reports the alert and decline rates the candidate would produce at the *current production thresholds*, and the condition step rejects a change above 20%. Where a model needs new thresholds, they ship in the same change set as the model, and the fraud ops approval covers both.

### 5. "Why was this card declined in March?"

**What happened.** A regulator asked for the reasoning behind a specific declined transaction, nine months later.

**What made it answerable.** The decisions table holds the model version, score, top SHAP reasons and threshold for every decision. The model version in the registry points to the training job, dataset URI, Git commit, evaluation and fairness report, and who approved it and when. The offline store's event-time history let the team reproduce the exact feature values the model saw. The answer took an afternoon, not a project.

## If you're starting tomorrow

1. Write the requirements table: latency, throughput, label delay, alert budget, retention.
2. Put the online feature computation in one place and let the offline store record it. Stop computing features in two languages.
3. Build the training pipeline with the champion-versus-challenger evaluation before you tune the model.
4. Turn on the registry with manual approval and an EventBridge-triggered deploy pipeline, even with one account at first.
5. Add data capture and an hourly drift job; add the precision and recall jobs once labels flow.
6. Load test staging, set scaling from the breaking point, and add the business alarm to auto-rollback.
7. Then split the accounts. It's easier when everything is already code.

## Further reading (official AWS documentation)

- [Machine Learning Lens, AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/machine-learning-lens/machine-learning-lens.html)
- [Feature Store online store storage types](https://docs.aws.amazon.com/sagemaker/latest/dg/feature-store-storage-configurations-online-store.html) and [cross-account access with AWS RAM](https://docs.aws.amazon.com/sagemaker/latest/dg/feature-store-cross-account-access-online-store.html)
- [Model Registry cross-account discoverability](https://docs.aws.amazon.com/sagemaker/latest/dg/model-registry-ram.html)
- [SageMaker AI project templates](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-projects-templates-sm.html)
- [Deployment guardrails](https://docs.aws.amazon.com/sagemaker/latest/dg/deployment-guardrails.html), [canary traffic shifting](https://docs.aws.amazon.com/sagemaker/latest/dg/deployment-guardrails-blue-green-canary.html) and [auto-rollback configuration](https://docs.aws.amazon.com/sagemaker/latest/dg/deployment-guardrails-configuration.html)
- [Shadow tests](https://docs.aws.amazon.com/sagemaker/latest/dg/shadow-tests.html)
- [Endpoint auto scaling policies](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-policy.html)
- [Model Monitor availability change](https://docs.aws.amazon.com/sagemaker/latest/dg/model-monitor-availability-change.html) and [Clarify availability change](https://docs.aws.amazon.com/sagemaker/latest/dg/clarify-availability-change.html)
- [Serverless MLflow on SageMaker AI (What's New, December 2025)](https://aws.amazon.com/about-aws/whats-new/2025/12/sagemaker-ai-serverless-mlflow-ai-development/)

The diagrams are in the repository as editable draw.io files: [all four in one file](/assets/diagrams/sagemaker-mlops/sagemaker-mlops-fraud-detection.drawio), or one per diagram next to each SVG.
