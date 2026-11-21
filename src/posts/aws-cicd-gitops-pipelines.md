---
title: "CI/CD and GitOps on AWS: CodePipeline, ECR and Argo CD on EKS with canaries that roll themselves back"
description: "A production CI/CD and GitOps design for EKS across AWS accounts: CodePipeline V2 and CodeBuild build and sign one image per commit, ECR holds it, Argo CD pulls it into dev, staging and prod, and Argo Rollouts runs canaries that abort on CloudWatch metrics. Requirements with numbers, a Well-Architected mapping, five rollback scenarios and three editable draw.io diagrams."
date: 2026-11-21T03:10:00Z
category: Cloud & DevOps
coverLabel: "Ship it.\nWatch it.\nRoll it back."
coverCode: "commit → canary 10% → abort in 3 min"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-cicd-gitops-pipelines.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Ship it. Watch it. Roll it back.', with the AWS logo."
---
Most deployment pipelines I review have the same shape. A CI job builds an image, tags it `latest` or with a branch name, and then runs `kubectl apply` or `helm upgrade` against each cluster using credentials that live in the CI system. It works. It also means the most privileged thing in your company is a build server, that dev and prod may run different images built from the same commit, and that "roll back" means re-running an old job and hoping nothing else changed.

This article is the design I'd use instead on AWS today, for a team running containers on Amazon EKS across several accounts. CI builds and signs one image per commit and stops there. Git holds the desired state of every environment. Argo CD, running inside AWS, pulls that state into each cluster. Argo Rollouts sends a slice of real traffic to the new version and pulls it back on its own when the numbers go wrong.

There are three editable `.drawio` diagrams built with the AWS shapes that ship with draw.io, a requirements section with real numbers, a mapping to the AWS Well-Architected Framework, and five rollback scenarios written as what happened and what fixed it.

## The short version

- **Build once, promote the digest.** One commit produces one image, identified by its `sha256` digest. Dev, staging and prod run that exact digest. Promotion is a one-line change in Git, never a rebuild.
- **CI pushes artifacts, not deployments.** CodePipeline (V2 pipeline type) and CodeBuild build, test, scan, sign and push to Amazon ECR, then open a pull request. They hold no credentials for any cluster.
- **Clusters pull their own state.** Argo CD reconciles each EKS cluster from a GitOps repository. A merged pull request is the deployment, and the Git history is the audit log.
- **Gates are conditions, not people waiting on Slack.** CodePipeline V2 stage conditions check CloudWatch alarms and deployment windows before a promotion PR is opened. Humans approve prod, once, in the PR.
- **Canaries with automatic analysis.** Argo Rollouts shifts ALB traffic by weight and queries CloudWatch and Amazon Managed Service for Prometheus at each step. A failed analysis aborts the rollout in one ALB update.
- **Only signed images from your registry run in prod.** AWS Signer signs, Amazon Inspector scans, and an admission policy in the cluster refuses anything else.
- **Every environment is its own AWS account.** The pipeline, the registry and the GitOps control plane live in separate accounts from the workloads they serve.

## The scenario and its requirements

The example is a marketplace platform: 14 services on EKS, about 45 engineers in six teams, and a checkout path that handles around 2,400 requests per second at peak. Today they deploy twice a week in a release train, a bad release takes about an hour to undo, and an auditor has asked who approved the last ten production changes. Nobody could answer quickly.

### Functional requirements

1. Any merge to `main` in a service repository produces a tested, scanned, signed image and deploys it to dev without a human.
2. The same image is promoted to staging automatically when dev checks pass, and to production after an approval.
3. Production releases are progressive: a small share of traffic first, with automatic rollback on error rate, latency or business metrics.
4. A rollback to the previous version must not need a new build.
5. Every production change is traceable to a commit, a pull request and the person who approved it.
6. Infrastructure changes (Terraform) and application changes follow the same promotion rules, but through separate pipelines.

### Non-functional requirements

| Requirement | Target | Why this number |
|---|---|---|
| Lead time, merge to production | under 60 minutes, including a 30-minute staging soak | Small batches. Today it's 3 to 4 days |
| Deployment frequency | 30+ production deploys a day across all services | Two per service per day is normal once releases are cheap |
| Change failure rate | under 5% of prod deploys need a rollback or hotfix | DORA "high performer" range |
| Automated rollback time | under 5 minutes from first bad metric to 100% stable | One canary step plus two analysis intervals |
| Time to restore (human-driven) | under 15 minutes | Git revert, merge, sync |
| Blast radius of a bad release | at most 10% of requests for at most 5 minutes | First canary weight and analysis window |
| Credentials | no long-lived keys anywhere in CI or Git | Leaked CI keys are the most common way into a cloud account |
| Supply chain | only signed images from our ECR, no critical CVEs with a fix available | Enforced at admission, not by convention |
| Pipeline cost | under $400 a month for CI orchestration and the GitOps control plane, excluding build compute | Keep the platform cheaper than one on-call hour per week |
| Recovery of the CI/CD system itself | prod keeps running if the pipeline or Argo CD is down; deploys pause, nothing breaks | Delivery tooling must never be on the serving path |

The last row matters more than it looks. In a push model, a broken pipeline can leave a cluster half-updated. In a pull model, if Argo CD is down, every cluster keeps running what it last reconciled.

## The architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-cicd-gitops/aws-cicd-gitops-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-cicd-gitops/aws-cicd-gitops-reference.svg" alt="CI/CD and GitOps reference architecture across an AWS Organization. Developers merge to main in GitHub app repositories. In the Tooling account, a CodePipeline V2 pipeline runs five numbered stages: Source through CodeConnections triggered on main; Build and test with CodeBuild producing an Arm64 image; Scan and SBOM with Amazon Inspector, failing on critical findings; Sign the digest with AWS Signer using Notation; and Promote, where CodeBuild opens a pull request that bumps the dev digest. The pipeline pushes the image, SBOM and signature to Amazon ECR in a Shared services account, which has immutable tags, a repository policy limited to the organisation, KMS encryption, Inspector continuous rescans and replication to a DR region. The promotion pull request goes to a GitOps config repository with base manifests and dev, staging and prod overlays, each pinning the image by digest. In a Platform account, an EKS management cluster runs Argo CD with an ApplicationSet per service; its Pod Identity role assumes one deploy role per cluster through STS. Argo CD pulls from Git and syncs to EKS clusters in separate Dev, Staging and Prod accounts, each running Argo Rollouts and Kyverno and granting the deploy role through an EKS access entry. Dev auto-syncs on every merge, staging after dev passes integration tests, prod after approval and a deployment window. Every cluster pulls images by digest from the shared ECR. In prod, an ALB has stable and canary target groups, CloudWatch measures 5xx by target group, Managed Prometheus measures p99 latency, and SLO burn-rate alarms notify SNS for chat and on-call. Argo Rollouts analysis queries CloudWatch and Prometheus every 60 seconds during a canary." width="1500" height="960" loading="lazy"></a><figcaption>Five accounts, one direction of trust: CI writes images and pull requests, clusters pull everything else.</figcaption></figure>

The accounts, and why each one exists:

- **Tooling account.** CodePipeline, CodeBuild and the CodeConnections link to GitHub. Its roles can push to ECR and open pull requests. They cannot reach any cluster, which is the point.
- **Shared services account.** ECR, the KMS key that encrypts it, and the AWS Signer signing profile. Every workload account pulls from here, so a repository policy scoped with `aws:PrincipalOrgID` replaces dozens of per-account grants.
- **Platform account.** A small EKS cluster that runs Argo CD and nothing else. Its controller role can assume one narrowly scoped deploy role per target cluster.
- **Dev, staging and prod accounts.** The workloads. Each cluster grants the Argo CD deploy role access through an [EKS access entry](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html), scoped to the namespaces that role manages.

If you're building the account structure from scratch, the [Terraform on AWS enterprise guide](/blog/terraform-aws-enterprise-guide/) covers the state layout and per-account CI roles that sit underneath this.

## CI: CodePipeline V2 and CodeBuild

The CI pipeline has one job: turn a commit into a trustworthy artifact. It doesn't deploy anything.

### Pipeline settings that matter

Use the **V2 pipeline type**. It's the one with Git triggers that filter on branches, tags and file paths, pipeline-level variables, stage conditions, and execution modes. V2 is billed per action execution minute rather than per active pipeline, which suits a platform with many small pipelines.

- **Trigger:** push to `main`, with file path filters so a docs-only change in a monorepo doesn't build every service.
- **Execution mode:** `QUEUED` for the promotion pipeline, so two releases never race through staging at the same time, and `SUPERSEDED` (the default) for CI, where only the newest commit matters.
- **Source:** GitHub through [AWS CodeConnections](https://docs.aws.amazon.com/dtconsole/latest/userguide/welcome-connections.html). No personal access tokens stored anywhere.
- **Build compute:** CodeBuild on Arm (Graviton) when your services run on Graviton nodes. Building natively avoids emulation and is usually both faster and cheaper than cross-building with QEMU.

### What the build does

A trimmed `buildspec.yml` for one service:

```yaml
version: 0.2
env:
  variables:
    REPO: 111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout
phases:
  pre_build:
    commands:
      - aws ecr get-login-password | docker login --username AWS --password-stdin ${REPO%%/*}
      - TAG=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-12)
  build:
    commands:
      - make test lint
      - docker build --pull -t $REPO:$TAG .
      # SBOM from the local image, then scan it before anything is pushed
      - inspector-sbomgen container --image $REPO:$TAG -o sbom.json
      - aws inspector-scan scan-sbom --sbom file://sbom.json --output-format CYCLONE_DX_1_5 > findings.json
      - ./ci/fail-on-findings.sh findings.json --severity CRITICAL --fixable-only
  post_build:
    commands:
      - docker push $REPO:$TAG
      - DIGEST=$(aws ecr describe-images --repository-name checkout --image-ids imageTag=$TAG --query 'imageDetails[0].imageDigest' --output text)
      - notation sign --plugin com.amazonaws.signer.notation.plugin --id $SIGNING_PROFILE_ARN $REPO@$DIGEST
      - printf '{"digest":"%s"}' $DIGEST > image.json
artifacts:
  files: [image.json, sbom.json]
```

Four details in there are deliberate:

1. **The tag is the commit SHA, and the repository has immutable tags.** Nobody can push a different image under the same tag. Everything downstream uses the digest anyway, but immutable tags stop the classic "someone re-pushed `v1.4.2`" incident.
2. **The scan runs before the push.** The [Inspector SBOM generator](https://docs.aws.amazon.com/inspector/latest/user/sbom-generator.html) builds an SBOM from the local image and the Inspector Scan API evaluates it, so a critical, fixable CVE fails the build without the image ever reaching the registry. ECR enhanced scanning then keeps rescanning pushed images as new CVEs are published.
3. **The signature is over the digest.** [AWS Signer](https://docs.aws.amazon.com/signer/latest/developerguide/Welcome.html) with the Notation plugin stores the signature in ECR next to the image. It says "this exact content came out of our pipeline", which a tag can't.
4. **The output is a digest in a file.** The next stage reads `image.json` and opens a pull request against the GitOps repository. That pull request is the only thing CI changes outside ECR.

The CodeBuild role has `ecr:PutImage` on the service's repository, `signer:SignPayload` on one signing profile, and a GitHub App token (from Secrets Manager) that can open PRs against one repository. Nothing else. For the GitHub side, the [workload identity federation article](/blog/workload-identity-federation-ci/) explains why this beats long-lived keys.

### ECR as the hand-off point

The registry is where CI's job ends and the clusters' job begins, so it carries more policy than people expect:

- **Repository policy** allowing pulls from any principal in the organisation (`aws:PrincipalOrgID`) and pushes only from the CI role in the tooling account.
- **Pull-through cache** for base images from public registries, so builds don't depend on Docker Hub rate limits, and so Inspector scans the base images you actually use.
- **Lifecycle policy** that expires untagged images after 14 days and keeps the last 200 tagged images. Never expire anything a running Rollout might roll back to; 200 builds is weeks of history even for busy services.
- **Replication** to your DR region, so a regional failover doesn't also need a rebuild of every image.
- **Encryption** with a customer managed KMS key in the shared services account, with a key policy that lets workload account roles decrypt.

## CD: Argo CD pulls from Git

### Why pull beats push here

In a push model the pipeline needs cluster-admin-ish credentials for every cluster it deploys to. In a pull model the cluster's own controller reads Git and applies the difference. Three things get better:

- **Credentials.** No cluster credential leaves AWS. The Argo CD controller assumes an IAM role, and each target cluster decides what that role may do.
- **Drift.** Argo CD compares live state with Git continuously, by default about every three minutes, and on every webhook. With `selfHeal` on, a manual `kubectl edit` in prod is reverted and shows up as an event.
- **Rollback and audit.** The desired state of prod at any moment is a commit. `git log overlays/prod` answers the auditor's question.

### Topology: one Argo CD or many?

| Option | How it works | Good when | Watch out for |
|---|---|---|---|
| Hub and spoke (shown) | One Argo CD in a platform account manages all clusters through cross-account roles | Up to a few dozen clusters, one platform team | The hub is a single control point; size it and back it up |
| Argo CD per cluster | Each cluster runs its own Argo CD watching its own overlay | Strict isolation between environments, or regulated prod | More instances to upgrade and secure; no single view |
| Managed Argo CD on EKS | AWS runs Argo CD as an EKS capability, outside your clusters | You want GitOps without operating Argo CD itself | Check regional availability and which Argo CD features and versions it exposes |
| Flux | Per-cluster controllers, Kustomize and Helm native, no central UI | Teams that prefer small composable controllers | Progressive delivery is through Flagger rather than Argo Rollouts |

Any of these satisfies the requirements above. What matters is that the clusters pull, and that the controller's IAM role is the only path into each cluster.

### Wiring Argo CD to EKS without static credentials

1. Run Argo CD on the management cluster with an IAM role for its application controller and server, through [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) or IRSA.
2. In each workload account, create a `argocd-deployer` role that trusts only that controller role.
3. On each workload cluster, add an access entry for `argocd-deployer` with an access policy scoped to the application namespaces. Platform add-ons that need cluster scope get a separate role.
4. Register the cluster in Argo CD with a cluster secret that uses `awsAuthConfig` with the cluster name and the deployer role ARN. No kubeconfig, no tokens.

Then let an ApplicationSet create one Application per service per environment, so adding a service is a folder in Git, not a ticket:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - matrix:
        generators:
          - clusters:
              selector:
                matchLabels: {platform/managed: "true"}
          - git:
              repoURL: https://github.com/example/gitops-config.git
              revision: main
              directories:
                - path: "apps/*"
  template:
    metadata:
      name: '{{.path.basename}}-{{.metadata.labels.env}}'
    spec:
      project: '{{.metadata.labels.env}}'
      source:
        repoURL: https://github.com/example/gitops-config.git
        targetRevision: main
        path: 'apps/{{.path.basename}}/overlays/{{.metadata.labels.env}}'
      destination:
        server: '{{.server}}'
        namespace: '{{.path.basename}}'
      syncPolicy:
        automated: {prune: true, selfHeal: true}
        syncOptions: [CreateNamespace=false]
```

One Argo CD `AppProject` per environment limits which clusters and namespaces an Application may target, so a typo in a path can't deploy a staging overlay into prod.

## Promotion across accounts

<figure class="diagram wide"><a href="/assets/diagrams/aws-cicd-gitops/aws-gitops-promotion.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-cicd-gitops/aws-gitops-promotion.svg" alt="Promotion of one image digest through dev, staging and prod. In the Tooling account, a CodePipeline V2 promotion pipeline in QUEUED execution mode starts from an image built and signed as sha256:9f3c...e21 by CI run 4182. Stage dev: CodeBuild opens a pull request and a bot auto-merges it. Entry conditions for staging: a LambdaInvoke rule checks the Argo CD application is Synced and Healthy and that smoke and API tests pass. Stage staging: the pull request is auto-merged after the gate. Entry conditions for prod: a CloudWatchAlarm rule requires no SLO alarm in staging for 30 minutes, a DeploymentWindow rule allows Tuesday to Thursday 09:00 to 16:00, then a manual approval action by the service owner. Stage prod: the pull request needs two CODEOWNERS reviews before merge. On a failed stage the pipeline rolls back to the last successful execution and no pull request is opened. Each stage writes to an overlay in the GitOps config repo: overlays/dev, overlays/staging and overlays/prod kustomization files pin the checkout image by digest; prod still shows the previous digest sha256:41aa...07b until its pull request merges. Base manifests (Rollout, Service, HPA, PDB, NetworkPolicy) are shared. Branch rules: the CI bot may merge dev, a bot may merge staging after gate 1, and prod requires two CODEOWNERS reviews and signed commits. Argo CD pulls each overlay into its own cluster in the Dev, Staging and Prod accounts. Dev and staging auto-sync with prune and selfHeal, staging runs a weekly load test at twice prod traffic, and prod auto-syncs on merge with a canary at 10, 25, 50 and 100 percent with analysis. Rules: one build per commit; CI writes only to the dev overlay; config and image move together in one PR; Argo CD has read-only Git access and nobody has kubectl write in prod except break-glass." width="1500" height="840" loading="lazy"></a><figcaption>The promotion pipeline decides when, Git records what, Argo CD makes it so. The digest never changes between environments.</figcaption></figure>

### The GitOps repository layout

```text
apps/
  checkout/
    base/                 # Rollout, Service x2, Ingress, HPA, PDB, NetworkPolicy
    overlays/
      dev/kustomization.yaml
      staging/kustomization.yaml
      prod/kustomization.yaml   # replicas, resources, canary steps, image digest
```

Each overlay pins the image with Kustomize's `images` field:

```yaml
images:
  - name: checkout
    newName: 111122223333.dkr.ecr.us-east-1.amazonaws.com/checkout
    digest: sha256:9f3c...e21
```

Promotion is a pull request that copies the digest from one overlay to the next. If the same PR also changes config, a reviewer sees the image change and the YAML change side by side, which is exactly what you want when something goes wrong at 14:06 on a Tuesday.

### The promotion pipeline

A second CodePipeline V2 pipeline, triggered by the CI pipeline finishing, moves the digest along. Each stage runs one small CodeBuild action that opens (and, for dev and staging, merges) a pull request. The gates between stages use [stage conditions](https://docs.aws.amazon.com/codepipeline/latest/userguide/stage-conditions.html) with built-in rules:

- **Before staging:** a `LambdaInvoke` rule that asks Argo CD whether the dev Application is `Synced` and `Healthy` for the new digest, and checks the smoke and API test results.
- **Before prod:** a `CloudWatchAlarm` rule that fails if any staging SLO alarm has been in `ALARM` in the last 30 minutes, and a `DeploymentWindow` rule for Tuesday to Thursday, 09:00 to 16:00 local time. Then a manual approval action, which is where the service owner looks at the PR.
- **On failure:** the stage's result is set to roll back to the last successful pipeline execution, and no promotion PR is opened.

Why not let Argo CD or a tool like Kargo handle promotion entirely? You can, and Kargo is a good fit if your team already lives in Argo. Using CodePipeline here keeps the approval trail, deployment windows and CloudWatch gates in one AWS-native place that the change board already knows how to audit. Whatever does the promoting, the rule is the same: promotion writes to Git and nothing else.

If you have services that aren't on GitOps yet, CodePipeline also has an [Amazon EKS deploy action](https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-EKS.html) that applies manifests or Helm charts directly. It's a reasonable stepping stone, but it's a push model, so keep it out of prod once Argo CD is in place.

## Progressive delivery and automatic rollback

<figure class="diagram wide"><a href="/assets/diagrams/aws-cicd-gitops/aws-canary-rollback.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-cicd-gitops/aws-canary-rollback.svg" alt="Canary with automatic rollback in the prod account, us-east-1. Shoppers at about 2,400 requests per second reach an ALB listener rule that forwards to two target groups with weights set by Argo Rollouts: 90 percent to the stable ReplicaSet v41, 12 pods with digest sha256:41aa...07b in target group checkout-stable, and 10 percent to the canary ReplicaSet v42, 2 pods with digest sha256:9f3c...e21 in target group checkout-canary, inside the EKS checkout namespace. The Argo Rollouts controller, running Rollout checkout with AnalysisTemplate checkout-slo, sets the weights through the AWS Load Balancer Controller. An AnalysisRun queries CloudWatch (HTTPCode_Target_5XX_Count over RequestCount per target group) and Managed Prometheus (checkout p99 latency for canary pods only) every 60 seconds. The AnalysisTemplate requires a 5xx rate under 1 percent with failureLimit 1, p99 latency under 800 milliseconds and payment success above 97 percent. Rollout steps in the prod overlay: setWeight 10 percent and pause 5 minutes with analysis, 25 percent and 5 minutes, 50 percent and 10 minutes, then 100 percent and scale down the old ReplicaSet after 30 seconds; about 25 minutes in total, and a second failed measurement aborts back to 0 percent canary in one ALB update. A timeline of a real rollback on a Tuesday: 14:02 prod PR merged changing the checkout digest from 41aa to 9f3c; Argo CD webhook starts the sync and schedules 2 canary pods; 14:04 canary pods Ready and weight set to 10 percent; 14:05 analysis 1 passes with 0.3 percent 5xx and p99 610 milliseconds; 14:06 analysis 2 fails with 3.1 percent 5xx and p99 1.9 seconds; 14:07 analysis 3 fails with 3.4 percent, exceeding failureLimit 1, and the rollout aborts with canary weight 0 and the ALB sending 100 percent to stable; 14:08 a notification goes to the team channel without paging; 14:20 the cause is found, a new payment client timeout of 300 milliseconds instead of 800; 14:31 a git revert is merged in the prod overlay and Argo CD shows Synced and Healthy; the next day the fix ships through dev and staging again, and staging now replays a payment-provider latency profile. Shoppers saw errors on about 0.3 percent of checkout requests for 3 minutes. The blast radius stayed small because only 10 percent of requests reached v42, the analysis used canary-only metrics, the rollback was an ALB weight change with no new pods, and the git revert made Git match reality." width="1500" height="880" loading="lazy"></a><figcaption>The canary at 10%, the analysis that failed it, and the three minutes of customer impact that followed.</figcaption></figure>

A Kubernetes rolling update replaces pods gradually, but it has no idea whether the new pods are *good*. Readiness probes only tell you a pod can serve, not that it serves correctly (the [readiness vs liveness article](/blog/kubernetes-readiness-vs-liveness/) goes into why). [Argo Rollouts](https://argoproj.github.io/argo-rollouts/) replaces the Deployment with a `Rollout` that moves traffic in steps and checks real metrics between them.

### Traffic splitting with the ALB

With the AWS Load Balancer Controller, Argo Rollouts uses [ALB traffic routing](https://argoproj.github.io/argo-rollouts/features/traffic-management/alb/): two Services (stable and canary), two target groups, and one listener rule whose forward weights the controller edits. The stable ReplicaSet stays at full size during the canary, so aborting is just a weight change. No pods start, no images are pulled.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: checkout
spec:
  replicas: 12
  strategy:
    canary:
      stableService: checkout-stable
      canaryService: checkout-canary
      trafficRouting:
        alb:
          ingress: checkout
          servicePort: 80
      analysis:
        templates:
          - templateName: checkout-slo
        startingStep: 1
      steps:
        - setWeight: 10
        - pause: {duration: 5m}
        - setWeight: 25
        - pause: {duration: 5m}
        - setWeight: 50
        - pause: {duration: 10m}
      scaleDownDelaySeconds: 30
```

### Analysis that reads AWS metrics

The analysis has to compare the canary against a threshold using **canary-only** metrics. ALB target group metrics are perfect for this, because the canary has its own target group. Argo Rollouts has a [CloudWatch metric provider](https://argoproj.github.io/argo-rollouts/analysis/cloudwatch/):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: checkout-slo
spec:
  metrics:
    - name: canary-5xx-rate
      interval: 1m
      failureLimit: 1
      successCondition: "all(result[0].Values, {# < 0.01})"
      provider:
        cloudWatch:
          interval: 5m
          metricDataQueries:
            - id: rate
              expression: "errors / requests"
            - id: errors
              returnData: false
              metricStat:
                metric:
                  namespace: AWS/ApplicationELB
                  metricName: HTTPCode_Target_5XX_Count
                  dimensions:
                    - {name: TargetGroup, value: targetgroup/checkout-canary/0123456789abcdef}
                    - {name: LoadBalancer, value: app/prod-shop/0123456789abcdef}
                period: 60
                stat: Sum
            - id: requests
              returnData: false
              metricStat:
                metric:
                  namespace: AWS/ApplicationELB
                  metricName: RequestCount
                  dimensions:
                    - {name: TargetGroup, value: targetgroup/checkout-canary/0123456789abcdef}
                    - {name: LoadBalancer, value: app/prod-shop/0123456789abcdef}
                period: 60
                stat: Sum
```

Add a Prometheus metric for p99 latency of canary pods (from Amazon Managed Service for Prometheus, through a SigV4 proxy or the provider's auth settings), and one **business** metric: payment success rate for requests served by the canary. The business metric is the one that catches bugs that return HTTP 200 with the wrong answer.

Two practical notes:

- **Low traffic makes analysis lie.** At 10% of 3 requests per second, one error is a 3% error rate. For quiet services, require a minimum request count in the success condition, or use longer pauses.
- **Keep the analysis numbers in Git**, next to the Rollout. Tightening a threshold is then a reviewed change, like any other.

### What about the database?

Traffic can be rolled back in seconds; a schema can't. The rule that makes canaries safe is **expand and contract**: a release may add columns, tables or indexes that the old version ignores, but must not remove or rename anything the old version still reads. The removal ships two releases later, once no running version needs it. Run migrations as an Argo CD PreSync hook or a separate Job with its own sync wave, and make them idempotent.

## Five rollback scenarios

### 1. The canary that failed itself

This is the one in the diagram. A new payment client library shipped with a 300 ms timeout where the old one used 800 ms. Unit tests passed. Staging passed, because staging's payment sandbox answers in 40 ms. In prod, the real provider's p99 is around 450 ms, so a share of canary checkout requests timed out.

**What happened:** canary at 10% from 14:04, two failed analysis runs at 14:06 and 14:07, rollout aborted at 14:07. Shoppers saw errors on roughly 0.3% of checkout requests for about three minutes. The team got a chat message, not a page.

**What fixed it:** a `git revert` of the prod overlay PR at 14:31, so Git matched what was running. The fix went through dev and staging again the next day, and staging now replays a latency profile recorded from the real provider. Without the canary, the same bug would have hit every checkout until a human noticed the dashboard.

### 2. The change that wasn't in the image

**What happened:** a PR lowered the checkout HPA's `maxReplicas` from 60 to 20 to save money in staging, but the change was made in `base/` instead of `overlays/staging/`. It reached prod in the next promotion. Nothing broke until the evening peak, when checkout couldn't scale past 20 pods and p99 latency climbed to 2.5 seconds.

Argo Rollouts couldn't catch this. An HPA change isn't a new ReplicaSet, so there's no canary.

**What fixed it:** `git revert` of the commit and a merge. Argo CD synced the HPA back within a minute of the webhook. Someone tried `argocd app rollback` first and it refused, because rollback isn't allowed on an Application with automated sync enabled. That's correct behaviour: the fix for GitOps is always in Git.

**What changed afterwards:** a policy check in CI (Conftest or Kyverno CLI against the rendered overlays) that fails any PR where prod's `maxReplicas` drops by more than 25%, and CODEOWNERS on `base/` so platform engineers see changes that affect every environment.

### 3. An unsigned image tried to run in prod

**What happened:** during an incident, an engineer built a debug image on a laptop, pushed it to a personal ECR repository in the dev account, and changed the image of a prod pod with `kubectl set image` through a break-glass role.

**What stopped it:** two things. Kyverno's image verification policy in prod rejected the pod, because the image had no Notation signature from the pipeline's AWS Signer profile. And even if it hadn't, `selfHeal` would have reverted the change within minutes. The break-glass session was logged in CloudTrail and reviewed the next morning.

**The lesson:** if your debug process needs a custom image in prod, build it through the pipeline with a `debug` flag. Break-glass should give you `kubectl exec` and logs, not a way around the supply chain.

### 4. A critical CVE in a base image, on a Friday

**What happened:** a critical OpenSSL CVE was published. Amazon Inspector's continuous rescanning flagged 11 of the 14 services' current prod images within the hour.

**What fixed it:** an EventBridge rule on Inspector findings with severity `CRITICAL` started a CodeBuild job that bumped the base image digest in each affected service and opened PRs. The CI pipelines rebuilt and signed the images, the promotion pipeline moved them through dev and staging, and prod PRs were approved in a batch. All 11 services were patched in production in 2 hours 40 minutes, every one through a canary. Under the old release-train process it would have been an emergency change board and a weekend.

### 5. Argo CD itself went down

**What happened:** an EKS version upgrade on the management cluster went wrong and Argo CD was unavailable for 50 minutes.

**What the impact was:** none for customers. Every workload cluster kept running its last reconciled state, Rollouts in progress kept their current weights, and Argo Rollouts controllers (which run inside each workload cluster) still completed or aborted analyses on their own. Merges to the GitOps repo queued up and synced when Argo CD came back.

**What changed afterwards:** the management cluster is upgraded through the same promotion path as everything else, with a staging management cluster in front of it. Argo CD's configuration lives in Git, so rebuilding it from scratch takes about 20 minutes.

## Mapping to the AWS Well-Architected Framework

| Pillar | What this design does | Relevant guidance |
|---|---|---|
| Operational excellence | Small, frequent, reversible changes; deployment state in Git; automated canary analysis; runbooks replaced by `git revert` | OPS05 (reduce defects, ease remediation), OPS06 (mitigate deployment risks) |
| Security | No long-lived credentials; CI can't reach clusters; signed images verified at admission; SBOM and CVE gates; separate accounts for tooling, artifacts and workloads | SEC11 (application security across the development and deployment lifecycle), plus the identity and permissions questions |
| Reliability | Progressive delivery limits blast radius; stable ReplicaSet kept warm for instant abort; delivery tooling off the serving path; images replicated to the DR region | REL08 (implement change) |
| Performance efficiency | Native Arm builds for Graviton workloads; same image tested in staging under 2x load as runs in prod | Experiment and measure before you promote |
| Cost optimization | V2 pipelines billed per action minute; no idle build servers; ECR lifecycle policies; one small management cluster | Pay for what you use, remove unused resources |
| Sustainability | Fewer rebuilds (one image per commit), pull-through cache instead of repeated public pulls, path filters so unrelated changes don't build | Reduce work you don't need to do |

The [DevOps Guidance](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/devops-guidance.html) in the Well-Architected documentation goes further on deployment practices, and is a good checklist for a team adopting this design.

## What it costs

Approximate monthly numbers for the scenario above, in us-east-1. Check the current pricing pages before you budget.

| Item | Assumption | Rough monthly cost |
|---|---|---|
| CodePipeline V2 | ~40 CI runs and ~30 promotions a day, ~25 action minutes each, at $0.002 per action minute | ~$100 |
| EKS management cluster | Control plane at $0.10 an hour, plus 3 small Graviton nodes | ~$73 + ~$100 |
| ECR storage | 14 repositories, ~200 images each, layers shared | Tens of dollars |
| Inspector | Enhanced scanning of pushed and rescanned images | Depends on image count; usually well under the cost of one engineer-hour a week |
| CodeBuild compute | Billed per build minute by compute type; usually the largest line | Size it from your own build times |

The rough total for orchestration and the control plane sits well under the $400 target. CodeBuild minutes dominate everything else, so the cheapest optimisation is a faster build: layer caching, smaller images and not building services that didn't change.

## Production checklist

- One image per commit, tagged with the commit SHA, immutable tags on every ECR repository
- Inspector SBOM scan before push, enhanced scanning after; CVE gate on critical and fixable
- Images signed with AWS Signer; admission policy in staging and prod verifies the signature
- CI roles can push to ECR and open PRs; no CI role can reach a cluster
- GitOps repo with overlays per environment, images pinned by digest, CODEOWNERS on `base/` and prod
- Argo CD with `prune` and `selfHeal`, AppProjects per environment, SSO through IAM Identity Center, no local admin
- Cross-account access through IAM roles and EKS access entries, scoped to namespaces
- Promotion pipeline in QUEUED mode with CloudWatch alarm and deployment window conditions
- Argo Rollouts with canary-only analysis on errors, latency and one business metric
- Expand-and-contract database migrations, run as sync hooks with their own wave
- Break-glass access logged and reviewed, never a path around signing
- DORA metrics (lead time, deploy frequency, change failure rate, time to restore) reported per team every month

## Download the diagrams

All three diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the account names, regions and service names to match your platform.

- [All three diagrams in one file (3 pages)](/assets/diagrams/aws-cicd-gitops/aws-cicd-gitops.drawio)
- [CI/CD and GitOps reference architecture](/assets/diagrams/aws-cicd-gitops/aws-cicd-gitops-reference.drawio)
- [Promotion across accounts](/assets/diagrams/aws-cicd-gitops/aws-gitops-promotion.drawio)
- [Canary with automatic rollback](/assets/diagrams/aws-cicd-gitops/aws-canary-rollback.drawio)

Account IDs, ARNs, digests, thresholds and timings are examples. Check current service features, quotas and regional availability before you build.

## References

- [CodePipeline pipeline types (V1 and V2)](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipeline-types.html)
- [CodePipeline stage conditions](https://docs.aws.amazon.com/codepipeline/latest/userguide/stage-conditions.html)
- [CodePipeline Amazon EKS deploy action](https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-EKS.html)
- [AWS CodeBuild User Guide](https://docs.aws.amazon.com/codebuild/latest/userguide/welcome.html)
- [AWS CodeConnections](https://docs.aws.amazon.com/dtconsole/latest/userguide/welcome-connections.html)
- [Amazon ECR image tag mutability](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html)
- [Amazon ECR pull through cache](https://docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache.html)
- [Amazon ECR lifecycle policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html)
- [Amazon Inspector SBOM generator](https://docs.aws.amazon.com/inspector/latest/user/sbom-generator.html)
- [AWS Signer Developer Guide](https://docs.aws.amazon.com/signer/latest/developerguide/Welcome.html)
- [Amazon EKS access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
- [Amazon EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- [Amazon EKS Best Practices Guide](https://docs.aws.amazon.com/eks/latest/best-practices/introduction.html)
- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [AWS Well-Architected DevOps Guidance](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/devops-guidance.html)
- [Argo CD documentation](https://argo-cd.readthedocs.io/en/stable/)
- [Argo Rollouts: AWS ALB traffic routing](https://argoproj.github.io/argo-rollouts/features/traffic-management/alb/)
- [Argo Rollouts: CloudWatch analysis](https://argoproj.github.io/argo-rollouts/analysis/cloudwatch/)
- [Flux documentation](https://fluxcd.io/flux/)
