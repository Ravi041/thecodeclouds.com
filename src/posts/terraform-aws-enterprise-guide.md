---
title: "Terraform on AWS for enterprises: how to start, and the practices that keep it sane"
description: "A practical starting plan for running Terraform across many AWS accounts: Organizations and the landing zone, S3 remote state with native locking, OIDC for CI, parent and child modules, and environments/*.tfvars."
date: 2026-11-17T04:00:00Z
category: Terraform
coverLabel: "Terraform\non AWS,\nat scale."
coverCode: "-var-file=environments/prod.tfvars"
coverLogos: "terraform-icon, aws"
coverImage: /assets/images/covers/terraform-aws-enterprise-guide.jpg
coverImageAlt: "Terraform cover reading 'Terraform on AWS, at scale.', with the Terraform and AWS logos."
---
Most companies don't start Terraform on AWS with a plan. Someone writes a `main.tf` for a VPC, it works, a second team copies it, and a year later there are forty folders, three state buckets nobody owns, an IAM user called `terraform-ci` with `AdministratorAccess`, and a prod plan that occasionally wants to replace a database.

None of that is Terraform's fault. It's what happens when the code arrives before the account structure, the state design and the pipeline do.

This guide is the order I'd do things in if I were starting Terraform for an enterprise on AWS today. If you're new to Terraform itself (providers, variables, `for_each`, modules, remote state), read the [Terraform best practices and module architecture guide](/blog/terraform-best-practices-module-architecture/) first. This one assumes those basics and focuses on what changes when the cloud is AWS and the company is big.

## The short version

- **Accounts are your blast radius.** One AWS account per workload per environment, grouped into OUs, created by AWS Organizations and a landing zone. Don't separate environments with tags or VPCs inside one account.
- **State lives in S3 with native locking.** Versioned, encrypted with KMS, public access blocked, one state file per stack per environment. DynamoDB locking is no longer needed.
- **CI uses OIDC, not access keys.** GitHub Actions (or GitLab) assumes an IAM role for a few minutes. A read-only role plans on pull requests; a separate role applies on `main` after approval.
- **Child modules do one thing; root modules compose them.** The same root module deploys dev, staging and prod, with the difference kept in `environments/<env>.tfvars`.
- **The provider refuses the wrong account.** `allowed_account_ids` and `assume_role` in every provider block. This one line has saved more prod accounts than any code review.
- **Guardrails sit above Terraform.** SCPs and RCPs stop the things no pipeline should ever do, whatever the IAM role says.

## Step 1: build the account structure before the code

The single best security and reliability decision on AWS is to split things into accounts. An account is a hard boundary for IAM, quotas, billing and mistakes. A developer with admin in the dev account can't touch prod, and a runaway `terraform destroy` in staging stops at the account edge.

Use **AWS Organizations** to create and group accounts, and **AWS Control Tower** (or your own landing zone, if you already have one) to set up the baseline: CloudTrail to a central log archive, AWS Config, IAM Identity Center for human sign-in, and a set of preventive controls. Control Tower is the faster path for most enterprises; it's opinionated, and those opinions are mostly right.

A structure that works for most companies:

| OU | Accounts | What lives there |
|---|---|---|
| `Security` | `log-archive`, `security-tooling` | Central CloudTrail and Config logs, GuardDuty and Security Hub delegated admin |
| `Infrastructure` | `network`, `shared-services`, `deployments` | Transit Gateway and egress, shared DNS and AMIs, Terraform state and CI roles |
| `Workloads/NonProd` | `payments-dev`, `payments-staging`, ... | Application accounts, one per workload per environment |
| `Workloads/Prod` | `payments-prod`, ... | The same, with stricter SCPs |
| `Sandbox` | One per engineer or team | Experiments, with a budget and auto-cleanup |

Keep the **management account** empty apart from Organizations, billing and Control Tower. Never run workload Terraform there, and never give CI a role in it.

### Creating accounts with Terraform

Once you have more than a handful of accounts, creating them by hand gets slow and inconsistent. You have two good options:

- **Account Factory for Terraform (AFT).** AWS's own pipeline on top of Control Tower. You open a pull request with an account request, and AFT creates the account, enrols it in Control Tower and runs your baseline customisations. It's a lot of moving parts, but it's supported and it scales to hundreds of accounts.
- **`aws_organizations_account` in a small, locked-down stack.** Fine for a few dozen accounts if you're not using Control Tower. Run it from a dedicated account with delegated permissions, never from a developer laptop.

Either way, every new account should come out of the factory with the same baseline: the Terraform deployment roles (more on those below), a default-deny on the root user, budgets, and the standard tags.

## Step 2: design state before the first `apply`

State is the most sensitive and most fragile thing Terraform owns. It can contain secrets in plain text, and if two people write it at once, it breaks. Get it right on day one.

### Where state lives

Put state buckets in the `deployments` account (or a dedicated `terraform-state` account), not inside the workload accounts. That way the people who can change prod infrastructure aren't automatically the people who can read prod state, and deleting a workload account doesn't delete the record of what was in it.

Use **one bucket per environment tier** (for example `acme-tfstate-nonprod` and `acme-tfstate-prod`), so a nonprod pipeline role can be denied the prod bucket outright with one bucket policy, instead of fragile key-prefix rules.

Inside the bucket, one state file per stack per environment:

```text
acme-tfstate-prod/
  network/prod/terraform.tfstate
  payments/app/prod/terraform.tfstate
  payments/data/prod/terraform.tfstate
```

Small states plan faster, fail smaller and can have different owners. A single state for "all of prod" is the most common enterprise mistake I see.

### The S3 backend with native locking

Since Terraform 1.10, the S3 backend can lock state with an S3 conditional write (`use_lockfile = true`). You no longer need a DynamoDB table for locking, and the DynamoDB option is deprecated. If you're migrating an older setup, turn on `use_lockfile` alongside the existing table first, then remove `dynamodb_table` once every pipeline is on a recent version.

Keep the backend block in the code minimal and pass the environment-specific part from a file, the same `environments/<env>.backend.hcl` pattern the generic guide uses:

```hcl
# backend.tf
terraform {
  backend "s3" {}
}
```

```hcl
# environments/prod.backend.hcl
bucket       = "acme-tfstate-prod"
key          = "payments/app/prod/terraform.tfstate"
region       = "eu-west-2"
encrypt      = true
kms_key_id   = "arn:aws:kms:eu-west-2:111111111111:alias/tfstate-prod"
use_lockfile = true
```

```sh
terraform init -backend-config=environments/prod.backend.hcl
```

### The bucket itself

The state bucket needs:

- **Versioning on**, so a corrupted or deleted state file can be recovered. Add a lifecycle rule that expires old noncurrent versions after 90 days or so.
- **SSE-KMS with a customer managed key**, and a key policy that only the deployment roles and a break-glass role can use. Reading the object isn't enough without `kms:Decrypt`.
- **Block Public Access** on, and **Object Ownership** set to bucket owner enforced.
- **A bucket policy** that denies non-TLS requests and denies everything except the named Terraform roles and break-glass.
- **Object Lock is optional.** It's tempting, but it can get in the way of state migrations. Versioning plus a tight policy is usually enough.

### The chicken-and-egg problem

The bucket that stores state has to be created by something. Keep a tiny `bootstrap` stack that creates the state buckets, KMS keys and deployment roles. Apply it once with local state, then add the backend block and run `terraform init -migrate-state` to move its own state into the bucket it just created. After that, it's a normal stack that changes rarely and needs two approvers.

## Step 3: a repository layout that scales

The generic guide covers parent and child modules in detail. On AWS at enterprise scale, I use two kinds of repository:

1. **A module repository** (or a few) with versioned child modules: `vpc`, `eks-cluster`, `rds-postgres`, `s3-bucket`, `iam-role`. Each one is released with a git tag or published to a private registry (HCP Terraform, Terraform Enterprise, or a Git-based source with `?ref=v1.4.0`).
2. **Live repositories** per team or domain, containing root modules (stacks) that call those modules, one set of `.tfvars` per environment.

A live repository looks like this:

```text
payments-infra/
  stacks/
    app/
      main.tf            # calls child modules
      variables.tf
      outputs.tf
      providers.tf
      backend.tf         # empty "s3" block
      versions.tf
      environments/
        dev.tfvars
        dev.backend.hcl
        staging.tfvars
        staging.backend.hcl
        prod.tfvars
        prod.backend.hcl
    data/
      ...same shape...
  .github/workflows/terraform.yml
```

The important rule: **the root module is identical across environments.** Prod doesn't get a different `main.tf`. If prod needs three NAT gateways and dev needs one, that's a variable, and its value lives in `prod.tfvars`. When the code is the same everywhere, a change tested in dev is the change that reaches prod.

### A child module, AWS flavoured

A child module should do one job, take a small number of meaningful inputs, and never configure its own provider:

```hcl
# modules/vpc/variables.tf
variable "name" {
  type = string
}

variable "cidr_block" {
  type = string
}

variable "azs" {
  type = list(string)
}

variable "nat_gateway_count" {
  type    = number
  default = 1

  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= length(var.azs)
    error_message = "nat_gateway_count must be between 1 and the number of AZs."
  }
}
```

```hcl
# modules/vpc/main.tf (excerpt)
resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_subnet" "private" {
  for_each          = { for i, az in var.azs : az => i }
  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.cidr_block, 4, each.value)
  tags              = { Name = "${var.name}-private-${each.key}", Tier = "private" }
}
```

Use `for_each` keyed by something stable (the AZ name here), not `count`. Removing the middle item from a `count` list renumbers everything after it and Terraform will want to destroy and recreate those subnets.

Don't write your own VPC module if you don't have to. The community `terraform-aws-modules` collection is well maintained. Many enterprises wrap it in a thin internal module that pins the version and sets the company defaults (flow logs on, specific tags, no public subnets unless asked).

### The root module that composes it

```hcl
# stacks/app/versions.tf
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
```

```hcl
# stacks/app/main.tf
module "vpc" {
  source = "git::https://github.com/acme/terraform-aws-modules.git//vpc?ref=v2.3.0"

  name              = "payments-${var.environment}"
  cidr_block        = var.vpc_cidr
  azs               = var.azs
  nat_gateway_count = var.nat_gateway_count
}

module "database" {
  source = "git::https://github.com/acme/terraform-aws-modules.git//rds-postgres?ref=v1.8.1"

  name                = "payments-${var.environment}"
  subnet_ids          = module.vpc.private_subnet_ids
  instance_class      = var.db_instance_class
  multi_az            = var.db_multi_az
  deletion_protection = var.environment == "prod"
}
```

```hcl
# stacks/app/environments/dev.tfvars
environment       = "dev"
account_id        = "222222222222"
vpc_cidr          = "10.17.0.0/16"
azs               = ["eu-west-2a", "eu-west-2b"]
nat_gateway_count = 1
db_instance_class = "db.t4g.medium"
db_multi_az       = false
```

```hcl
# stacks/app/environments/prod.tfvars
environment       = "prod"
account_id        = "333333333333"
vpc_cidr          = "10.16.0.0/16"
azs               = ["eu-west-2a", "eu-west-2b", "eu-west-2c"]
nat_gateway_count = 3
db_instance_class = "db.r7g.large"
db_multi_az       = true
```

Pin module versions with `?ref=` to a tag, and commit `.terraform.lock.hcl` so every run uses the same provider build. Upgrading a module in prod should be a pull request that changes one version number, nothing else.

## Step 4: make the provider refuse the wrong account

This is the cheapest safety net in the whole setup:

```hcl
# stacks/app/providers.tf
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  assume_role {
    role_arn     = "arn:aws:iam::${var.account_id}:role/terraform-deploy"
    session_name = "terraform-payments-app-${var.environment}"
  }

  default_tags {
    tags = {
      Environment = var.environment
      Owner       = "payments"
      ManagedBy   = "terraform"
      Repository  = "acme/payments-infra"
    }
  }
}
```

- **`allowed_account_ids`** makes Terraform stop before doing anything if the credentials point at a different account. Run a prod plan with dev credentials by mistake and you get an error, not a diff.
- **`assume_role`** means the pipeline starts with an identity in the `deployments` account and hops into the target account. The account ID in the tfvars decides where it lands.
- **`default_tags`** puts ownership and environment on every taggable resource without anyone remembering to.

AWS provider v6 also lets most resources take their own `region` argument, which removes the need for a pile of aliased providers when a stack touches two regions (a CloudFront certificate in `us-east-1`, for example). Use it for the odd resource; if a whole stack belongs in another region, give it its own root module.

## Step 5: CI with OIDC and two roles

No IAM users, no access keys in CI secrets. GitHub Actions, GitLab CI and most other platforms can issue an OIDC token that AWS exchanges for temporary credentials. I covered how that trade works in [Delete the cloud key in your CI pipeline](/blog/workload-identity-federation-ci/); here's how it fits Terraform.

Create two roles in each target account (the account factory should do this for you):

| Role | Who can assume it | Permissions | Used for |
|---|---|---|---|
| `terraform-plan` | Any branch or pull request of the infra repo | `ReadOnlyAccess`, plus read on the state bucket and KMS decrypt | `terraform plan` on pull requests |
| `terraform-deploy` | Only the `main` branch, in a protected GitHub environment | What the stacks in that account actually need, bounded by a permissions boundary | `terraform apply` after merge |

The trust policy for the deploy role pins the repository, the branch and the GitHub environment:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::333333333333:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:acme/payments-infra:environment:prod"
    }
  }
}
```

Then the pipeline is simple:

1. **On every pull request:** `terraform fmt -check`, `terraform validate`, `tflint`, a security scan, and `terraform plan` for each affected environment using the plan role. Post the plan to the pull request.
2. **On merge to `main`:** apply to dev, then staging, then prod. Prod waits for an approval in the GitHub environment, and re-runs the plan before applying so nobody approves a stale diff.

Read the plan before you approve it. [Read the Terraform plan, not just the green check](/blog/read-your-terraform-plan/) has a short routine for that.

Give humans the same split. Engineers get read-only in prod through IAM Identity Center, and a time-limited break-glass role for emergencies, logged and alerted on. If people can `apply` to prod from their laptops, the pipeline is a suggestion.

## Step 6: guardrails that Terraform can't bypass

IAM roles say what an identity may do. Organization policies say what *nobody* in an account may do, including a misconfigured Terraform role. Manage them in their own stack, owned by the platform or security team:

- **Service control policies (SCPs)** on the `Workloads` OUs: deny leaving the organization, deny disabling CloudTrail, GuardDuty and Config, deny regions you don't use, and deny changes to the Terraform roles except by the account factory.
- **Resource control policies (RCPs)** to stop data leaving the organization, for example denying S3 and KMS access to principals outside your org. They protect the state buckets too.
- **Tag policies** to enforce the values of `Environment` and `Owner`, so `default_tags` can't drift into `Prod`, `production` and `PRD`.

Test SCP changes in a sandbox OU first. An overly broad deny can break every pipeline in the company at once, and the error messages don't always say an SCP was the cause.

## Step 7: checks in the pipeline

You'll catch most problems before `plan` with a few cheap tools:

- **`terraform fmt -check` and `terraform validate`**, always.
- **TFLint with the AWS ruleset**, which knows things like invalid instance types and deprecated arguments.
- **A policy or security scanner** such as Checkov or Trivy, for unencrypted volumes, public buckets and open security groups. Start in warn mode, fix the noise, then make it blocking.
- **`terraform test`** for your child modules, so a module release proves it still produces what it promised.
- **Cost estimation** (Infracost or similar) on the pull request, so a change from `db.t4g.medium` to `db.r7g.4xlarge` gets a second look.

## Step 8: day two

Infrastructure doesn't stay where you put it. Plan for that from the start:

- **Drift detection.** A scheduled pipeline runs `terraform plan -detailed-exitcode` against every stack nightly and alerts when exit code 2 shows a difference nobody committed.
- **Importing what already exists.** Use `import` blocks and `terraform plan -generate-config-out=generated.tf` to bring console-built resources under management, then clean up the generated code before merging.
- **Refactoring without destroying.** When you rename a resource or move it into a module, add a `moved` block. Terraform updates the address in state instead of planning a replace.
- **Protecting the things that hurt.** `deletion_protection` on databases and load balancers, `lifecycle { prevent_destroy = true }` on the few resources whose loss is unrecoverable, and a pipeline rule that fails any plan containing a destroy in prod unless a label is added.
- **Provider and module upgrades on a schedule.** Renovate or Dependabot opening small upgrade PRs every week is far less painful than a once-a-year jump across major versions.

## How to start: a realistic first month

If you're starting from nothing, or from a pile of unmanaged folders, this order works:

**Week 1: foundations.** Set up Organizations and Control Tower, create the `Security`, `Infrastructure` and `Workloads` OUs, the log archive and security tooling accounts, and IAM Identity Center for people. Turn on the default controls. Nothing is in Terraform yet, and that's fine.

**Week 2: the Terraform platform.** Create the `deployments` account. Write and apply the `bootstrap` stack: state buckets, KMS keys, the GitHub OIDC provider and the plan and deploy roles. Migrate its state into S3. Decide on the module repository and the first three modules you'll need.

**Week 3: the first real workload.** Pick one low-risk service. Build its live repository with `environments/dev.tfvars` and `staging.tfvars`, the pipeline, and the checks. Get it to the point where a merge to `main` deploys dev and staging with no human running Terraform.

**Week 4: prod and the paved road.** Add `prod.tfvars`, the approval gate, drift detection and the SCPs. Write a one-page "how to start a new stack" guide, ideally as a template repository, so the second team copies something good instead of something improvised.

After that, it's repetition: every new workload gets accounts from the factory, a live repository from the template, and modules from the shared repository.

## Mistakes I'd avoid

- **One AWS account with dev, staging and prod in it.** Separating environments by tag or VPC isn't a security boundary.
- **One giant state for a whole environment.** Plans take ten minutes, every change locks everyone out, and one mistake has the widest possible reach.
- **Terraform workspaces as the environment switch** across accounts. They share a backend config and make it too easy to apply prod with the wrong variables. Separate tfvars and backend files make the target explicit.
- **Long-lived access keys** for CI or for the people running Terraform.
- **Modules that configure providers** or hard-code account IDs and regions. They can't be reused and they break `for_each` on modules.
- **Unpinned versions.** `source = "...//vpc"` with no `ref`, or `version = ">= 5.0"` on the provider, means next week's plan can differ from today's without a single commit.
- **Secrets in tfvars.** Store them in Secrets Manager or SSM Parameter Store and read them with a data source, or better, let the application read them at runtime. Use `sensitive = true` on variables and outputs, and remember that state still holds the values, which is why the state bucket is locked down.

## Further reading

- [Terraform best practices and module architecture](/blog/terraform-best-practices-module-architecture/), the generic guide this one builds on
- [S3 backend reference](https://developer.hashicorp.com/terraform/language/backend/s3), including `use_lockfile`
- [AWS Prescriptive Guidance: Terraform on AWS best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/introduction.html)
- [AWS Control Tower Account Factory for Terraform](https://docs.aws.amazon.com/controltower/latest/userguide/aft-overview.html)
- [Organizing your AWS environment using multiple accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/organizing-your-aws-environment.html)
