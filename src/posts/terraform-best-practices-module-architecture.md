---
title: "Terraform best practices: module architecture, per-environment tfvars and remote state"
description: "A beginner-to-standard guide to structuring Terraform: root and child modules, environments/dev.tfvars for each environment, meta-arguments, locals, local vs remote state, locking, versioning and a CI pipeline you can trust."
date: 2026-11-16T04:00:00Z
category: Terraform
coverLabel: "One module.\nThree environments.\nZero copy-paste."
coverCode: "-var-file=environments/dev.tfvars"
coverLogos: "terraform-icon"
coverImage: /assets/images/covers/terraform-best-practices-module-architecture.jpg
coverImageAlt: "Terraform cover reading 'One module. Three environments. Zero copy-paste.', with the Terraform logo."
---
Most Terraform repositories start the same way. One `main.tf`, a provider block, a few resources, and `terraform apply` from a laptop. It works, so someone copies the folder to make staging. Then prod. Six months later the three copies have drifted, nobody is sure which one is the "real" config, and a change to the network means editing the same block in three places and hoping you didn't miss one.

None of that is Terraform's fault. It's a structure problem, and it's easy to avoid if you set things up properly on day one.

This guide is the setup I'd hand to someone starting a Terraform codebase for a team today. It's cloud-neutral on purpose: the same layout works on AWS, Google Cloud and Azure, and the cloud-specific guides that follow this one build on it. If you're new to Terraform, read it top to bottom. If you've been using it for a while, skim the short version and jump to whatever you're unsure about.

## The short version

- **Write each piece of infrastructure once, as a child module.** A network, a cluster, a database. Modules take inputs, create resources and return outputs.
- **Compose modules in a root (parent) module.** The root module is the thing you run `terraform plan` in. It wires child modules together and owns the provider and backend configuration.
- **Keep one root module and one variable file per environment.** `environments/dev.tfvars`, `environments/staging.tfvars`, `environments/prod.tfvars`. The code is identical across environments. Only the values change.
- **Store state remotely, with locking, separately for each environment.** Never commit state to Git, and never let dev and prod share a state file.
- **Pin everything.** The Terraform version, the provider versions, and the module versions. Commit `.terraform.lock.hcl`.
- **Use `for_each` over `count` for anything that has a name.** It saves you from accidental destroys when a list changes order.
- **Plan in pull requests, apply from CI.** People review the plan. A pipeline with short-lived credentials runs the apply.

## How Terraform actually works, in one minute

Before the structure makes sense, it helps to be clear on four things Terraform juggles:

1. **Configuration:** the `.tf` files you write. They describe what you want to exist.
2. **Providers:** plugins that talk to an API. The AWS, Google and AzureRM providers are the big ones, but there are providers for Kubernetes, GitHub, Cloudflare, Datadog and hundreds more.
3. **State:** a JSON file that maps each resource in your configuration to the real object in the cloud. `aws_s3_bucket.logs` in your code is bucket `acme-prod-logs` in your account, and only the state knows that.
4. **The plan:** the difference between configuration, state and reality. `terraform plan` refreshes state from the real world, compares it with your configuration, and tells you what it would create, change or destroy.

Everything in this guide is about keeping those four things predictable. Good structure keeps configuration readable, pinned versions keep providers predictable, remote state keeps the mapping safe, and CI keeps the plan honest.

## The repository layout

Here's the layout this guide uses. It's not the only good one, but it's a solid default that scales from one engineer to a platform team.

```text
infra/
├── modules/                     # child modules: reusable building blocks
│   ├── network/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   ├── versions.tf
│   │   └── README.md
│   ├── compute/
│   └── database/
└── stacks/                      # root (parent) modules: things you deploy
    └── platform/
        ├── main.tf              # calls the child modules
        ├── variables.tf
        ├── outputs.tf
        ├── locals.tf
        ├── providers.tf
        ├── versions.tf
        ├── backend.tf           # empty partial backend block
        ├── .terraform.lock.hcl  # committed
        └── environments/
            ├── dev.tfvars
            ├── dev.backend.hcl
            ├── staging.tfvars
            ├── staging.backend.hcl
            ├── prod.tfvars
            └── prod.backend.hcl
```

Two folders, two jobs. `modules/` holds the reusable pieces and never has its own state. `stacks/` holds root modules, each of which has state and gets planned and applied. A small team might only ever have one stack. A larger one splits into several, for example `network`, `platform` and `data`, so that a change to an application database can't touch the VPC.

The file names inside each module are a convention, not a rule. Terraform reads every `.tf` file in a folder as one configuration. But everyone on the team knowing that variables live in `variables.tf` and outputs live in `outputs.tf` saves a lot of searching.

## Root modules and child modules

Every Terraform configuration is a module. The folder you run Terraform in is the **root module**, also called the parent. Any module it calls with a `module` block is a **child module**. Child modules can call their own children, but keep that shallow. Two levels is plenty, and one is usually better.

### Writing a child module

A child module is a small, focused unit with a clear contract: these inputs, these resources, these outputs. Here's a cut-down network module. The resource types are placeholders, because the shape is what matters, and the cloud guides fill in the real resources.

```hcl
# modules/network/variables.tf
variable "name" {
  description = "Name prefix for every resource in this module."
  type        = string
}

variable "cidr_block" {
  description = "Address range for the network, e.g. 10.10.0.0/16."
  type        = string

  validation {
    condition     = can(cidrhost(var.cidr_block, 0))
    error_message = "cidr_block must be a valid CIDR range."
  }
}

variable "subnets" {
  description = "Subnets to create, keyed by a short name."
  type = map(object({
    cidr   = string
    public = optional(bool, false)
  }))
}

variable "tags" {
  description = "Labels or tags applied to every resource."
  type        = map(string)
  default     = {}
}
```

```hcl
# modules/network/outputs.tf
output "network_id" {
  description = "ID of the network."
  value       = example_network.this.id
}

output "subnet_ids" {
  description = "Subnet IDs, keyed by the same names as var.subnets."
  value       = { for k, s in example_subnet.this : k => s.id }
}
```

```hcl
# modules/network/versions.tf
terraform {
  required_version = ">= 1.11"

  required_providers {
    example = {
      source  = "example/example"
      version = ">= 5.0"
    }
  }
}
```

A few habits that make child modules pleasant to use:

- **No provider blocks inside child modules.** A child declares which providers it needs in `required_providers`, and the root passes them in. Provider configuration inside a child makes the module impossible to use with `for_each` or `count`, and very hard to remove later.
- **No backend blocks either.** Only root modules have state.
- **Describe every variable and output.** The `description` is the module's documentation. Tools like `terraform-docs` turn it into a README for free.
- **Type everything.** `map(object({...}))` with `optional()` attributes catches mistakes at plan time instead of halfway through an apply.
- **Validate inputs.** A `validation` block that rejects a bad CIDR or a name with uppercase letters is cheaper than a failed API call.
- **Use a lower bound for provider versions in modules** (`>= 5.0`), and pin the exact version in the root. If every module pins its own exact version, they fight each other.
- **Call the main resource `this`** when a module creates one of something. `example_network.this` reads better than `example_network.network`.

### Calling it from the root module

The root module is mostly wiring. It reads the environment's values, passes them to child modules, and connects one module's outputs to another's inputs.

```hcl
# stacks/platform/main.tf
module "network" {
  source = "../../modules/network"

  name       = local.name_prefix
  cidr_block = var.network_cidr
  subnets    = var.subnets
  tags       = local.common_tags
}

module "compute" {
  source = "../../modules/compute"

  name          = local.name_prefix
  subnet_ids    = values(module.network.subnet_ids)
  instance_size = var.instance_size
  min_nodes     = var.min_nodes
  max_nodes     = var.max_nodes
  tags          = local.common_tags
}
```

Notice that `compute` uses `module.network.subnet_ids`. That reference is all Terraform needs to know that the network must exist first. You don't need `depends_on` here, and adding it would only make plans slower and less precise.

### Where modules come from

The `source` argument can point at a few places:

| Source | Example | When to use it |
| --- | --- | --- |
| Local path | `../../modules/network` | Modules that live in the same repository as the stack. The simplest start. |
| Git with a tag | `git::https://github.com/acme/tf-modules.git//network?ref=v1.4.0` | Shared modules in their own repository, versioned with tags. |
| Public registry | `terraform-aws-modules/vpc/aws` plus `version = "~> 5.0"` | Well-maintained community modules. Read the code before you trust it. |
| Private registry | `app.terraform.io/acme/network/aws` | Larger organisations with an internal module catalogue. |

Start with local paths. When a second team or repository needs the same module, move it to its own repository and tag releases. Never point a production stack at a branch like `?ref=main`. A tag means the same code every time, and a branch doesn't.

## One codebase, many environments: environments/dev.tfvars

This is the part most beginners get wrong, so it gets the most space.

The goal is that dev, staging and prod run **the same code** with **different values**. If prod has a bigger database, that's a value. If prod has a feature dev doesn't, that's a boolean variable. What you never want is a `prod/` folder with its own copy of `main.tf`.

### The variable files

Each environment gets a `.tfvars` file with only the values that differ.

```hcl
# stacks/platform/environments/dev.tfvars
environment   = "dev"
region        = "region-1"
network_cidr  = "10.10.0.0/16"
instance_size = "small"
min_nodes     = 1
max_nodes     = 3

subnets = {
  app  = { cidr = "10.10.1.0/24" }
  data = { cidr = "10.10.2.0/24" }
  edge = { cidr = "10.10.3.0/24", public = true }
}

enable_deletion_protection = false
```

```hcl
# stacks/platform/environments/prod.tfvars
environment   = "prod"
region        = "region-1"
network_cidr  = "10.30.0.0/16"
instance_size = "large"
min_nodes     = 3
max_nodes     = 12

subnets = {
  app  = { cidr = "10.30.1.0/24" }
  data = { cidr = "10.30.2.0/24" }
  edge = { cidr = "10.30.3.0/24", public = true }
}

enable_deletion_protection = true
```

Give each environment its own address range from the start. You'll want to connect them to each other or to an office network one day, and overlapping CIDRs make that painful.

The root module declares the variables, with types and validation, and with no defaults for anything that must be chosen per environment. A missing value should fail the plan, not silently fall back to a dev-sized setting in prod.

```hcl
# stacks/platform/variables.tf
variable "environment" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "min_nodes" {
  type = number
}

variable "max_nodes" {
  type = number

  validation {
    condition     = var.max_nodes >= var.min_nodes
    error_message = "max_nodes must be greater than or equal to min_nodes."
  }
}
```

Cross-variable validation like that `max_nodes >= min_nodes` check works from Terraform 1.9 onwards.

### Separate state per environment with a partial backend

Different values aren't enough. Each environment also needs its own state file, otherwise applying dev would try to rewrite prod. The clean way is a **partial backend configuration**: the `backend` block in code says which kind of backend, and a small per-environment file fills in where.

```hcl
# stacks/platform/backend.tf
terraform {
  backend "s3" {}   # or "gcs" {} or "azurerm" {}
}
```

```hcl
# stacks/platform/environments/dev.backend.hcl
bucket       = "acme-tfstate-dev"
key          = "platform/terraform.tfstate"
region       = "eu-west-1"
use_lockfile = true
```

Then every command names the environment twice, once for state and once for values:

```sh
cd stacks/platform

terraform init -reconfigure -backend-config=environments/dev.backend.hcl
terraform plan  -var-file=environments/dev.tfvars -out=dev.tfplan
terraform apply dev.tfplan
```

`-reconfigure` matters when you switch environments in the same folder. Without it, Terraform remembers the previous backend and may offer to copy state across, which is exactly what you don't want.

Typing two flags every time is how people end up planning dev values against prod state. Wrap it in a script or a Makefile so the environment is a single argument:

```make
# stacks/platform/Makefile
ENV ?= dev

init:
	terraform init -reconfigure -backend-config=environments/$(ENV).backend.hcl

plan: init
	terraform plan -var-file=environments/$(ENV).tfvars -out=$(ENV).tfplan

apply:
	terraform apply $(ENV).tfplan
```

`make plan ENV=staging` is much harder to get wrong. Even better, put prod state in a separate cloud account or project from dev, with different credentials. Then a mistake fails with "access denied" instead of succeeding in the wrong place.

### tfvars vs workspaces vs directories

There are three common ways to handle environments. Here's how they compare.

| Approach | How it works | Good for | Watch out for |
| --- | --- | --- | --- |
| **tfvars + backend files** (this guide) | Same code, one `.tfvars` and one backend file per environment | Most teams. Clear, reviewable, separate state and credentials per environment | You must pass the right files. Wrap it in a script |
| **CLI workspaces** | `terraform workspace select prod`, and `terraform.workspace` in code | Short-lived copies of the same environment, like a stack per feature branch | All workspaces share one backend and one set of credentials. Easy to forget which one is selected |
| **Directory per environment** | `envs/dev/main.tf` calls the modules with literal values | Environments that are genuinely different shapes | Drift between folders if they start copying resources instead of calling modules |

The Terraform docs themselves say CLI workspaces aren't a good fit for separating environments that need different credentials or access controls, and that's most real environments. Use tfvars files for dev, staging and prod. Reach for workspaces when you want throwaway copies.

If you do use directories, keep each environment folder thin: a `main.tf` that only calls modules, never a resource block. Then it's really the tfvars pattern with the values written inline.

### Variable precedence, so you know which value wins

Terraform reads variables from several places. Later ones in this list override earlier ones:

1. Default in the `variable` block
2. Environment variables named `TF_VAR_name`
3. `terraform.tfvars`, then `terraform.tfvars.json`
4. Any `*.auto.tfvars` files, in alphabetical order
5. `-var-file` and `-var` flags, in the order you pass them

Avoid `terraform.tfvars` and `*.auto.tfvars` in a multi-environment root module. They load silently, so a value meant for dev can quietly end up in a prod plan. Be explicit with `-var-file`.

## Locals, variables and outputs

These three get confused a lot. Think of a module like a function:

- **Variables** are the arguments. Callers set them.
- **Locals** are the variables inside the function body. Only the module sets them, and they're computed from variables, other locals and resource attributes.
- **Outputs** are the return values.

```hcl
# stacks/platform/locals.tf
locals {
  name_prefix = "acme-${var.environment}"

  common_tags = {
    environment = var.environment
    managed_by  = "terraform"
    stack       = "platform"
    owner       = "platform-team"
  }

  is_prod = var.environment == "prod"
}
```

Use a local when the same expression appears more than once, or when a name makes an expression easier to read. Don't use locals to hide constants that should be variables. If someone might reasonably want to change a value per environment, it's a variable.

Mark secrets as sensitive so they don't print in plans and logs:

```hcl
variable "db_password" {
  type      = string
  sensitive = true
}

output "db_connection_string" {
  value     = module.database.connection_string
  sensitive = true
}
```

`sensitive` hides the value from the CLI output. It does **not** keep it out of state. Anything a resource returns is stored in the state file in plain text, which is one of the reasons state needs to be in an encrypted, access-controlled backend. Better still, let the database generate and store its own password in your cloud's secret manager, and only pass the secret's name around. On Terraform 1.11 and later, ephemeral resources and write-only arguments let some providers handle secrets without writing them to state at all.

## Meta-arguments

Meta-arguments are arguments you can put on any resource or module block, whatever the provider. They change how Terraform manages the block rather than what the cloud API receives.

### count

`count` creates N copies of a block. It's best for "zero or one", which is how you make a resource optional:

```hcl
resource "example_bastion_host" "this" {
  count = var.enable_bastion ? 1 : 0

  name   = "${local.name_prefix}-bastion"
  subnet = module.network.subnet_ids["edge"]
}

output "bastion_ip" {
  value = one(example_bastion_host.this[*].public_ip)
}
```

The `one()` function returns the single value or `null`, so the output works whether the bastion exists or not.

What `count` is bad at is lists of named things. Resources are addressed by position, `this[0]`, `this[1]`, `this[2]`. Remove the first item from a list of three, and Terraform sees that index 0 changed and index 2 disappeared, so it destroys and recreates things you never meant to touch.

### for_each

`for_each` creates one copy per key of a map or set, and addresses each by its key. Removing one key removes only that resource.

```hcl
resource "example_subnet" "this" {
  for_each = var.subnets

  name       = "${var.name}-${each.key}"
  cidr_block = each.value.cidr
  public     = each.value.public
  network_id = example_network.this.id
}
```

The addresses are now `example_subnet.this["app"]`, `example_subnet.this["data"]` and `example_subnet.this["edge"]`, and they're stable whatever order the map is written in.

The keys must be known at plan time. You can't `for_each` over the IDs of resources that haven't been created yet. Use names you choose, not IDs the cloud assigns.

Rule of thumb: `count` for on/off, `for_each` for anything with a name.

### depends_on

Terraform works out ordering from references. When one block uses another's attribute, it waits for it. `depends_on` is for the rare case where a dependency exists but there's no attribute to reference, such as an IAM permission that must be in place before an application can start.

```hcl
resource "example_app" "this" {
  name = "${local.name_prefix}-api"

  depends_on = [example_role_binding.app_can_read_secrets]
}
```

Use it sparingly and add a comment explaining why. On a `module` block, `depends_on` makes every data source inside the module wait until apply, which can turn simple changes into "known after apply" noise.

### provider

Each resource uses the default configuration of its provider. When you need more than one, for example a second region or a second account, define an alias and select it with the `provider` meta-argument.

```hcl
# stacks/platform/providers.tf
provider "example" {
  region = var.region
}

provider "example" {
  alias  = "dr"
  region = var.dr_region
}

resource "example_bucket" "backup" {
  provider = example.dr
  name     = "${local.name_prefix}-backup"
}
```

Child modules receive aliased providers through the `providers` map on the `module` block:

```hcl
module "dr_network" {
  source = "../../modules/network"
  providers = {
    example = example.dr
  }
  # ...
}
```

### lifecycle

`lifecycle` changes how Terraform handles create, update and destroy for one resource.

```hcl
resource "example_database" "this" {
  name = "${local.name_prefix}-db"
  size = var.db_size

  lifecycle {
    prevent_destroy       = true
    create_before_destroy = false
    ignore_changes        = [tags["last_backup"]]
    replace_triggered_by  = [example_kms_key.db.id]

    precondition {
      condition     = !local.is_prod || var.db_size != "small"
      error_message = "Production databases can't use the small size."
    }
  }
}
```

- **`create_before_destroy`:** when a change forces replacement, build the new one before deleting the old. Useful for things like certificates and instance templates, where a gap would cause an outage. It doesn't work for resources with a fixed unique name, because two can't exist at once.
- **`prevent_destroy`:** fail any plan that would destroy this resource. A seatbelt for databases and storage. It can't be set from a variable, so it applies in every environment. Pair it with your cloud's own deletion protection setting, which can be per-environment.
- **`ignore_changes`:** stop Terraform from fighting another system that legitimately changes an attribute, like an autoscaler adjusting a node count. Don't use it to hide drift you don't understand.
- **`replace_triggered_by`:** replace this resource when another one changes.
- **`precondition` and `postcondition`:** assertions that run during plan or apply, with your own error message. Great for catching invalid combinations of inputs.

### Meta-arguments on modules

`count`, `for_each`, `depends_on` and `providers` all work on `module` blocks. `for_each` on a module is a neat way to stamp out the same thing several times from a map, for example one team project per entry. `lifecycle` doesn't work on modules. Put it on the resources inside.

## Refactoring without destroying: moved, import and removed

Sooner or later you'll rename a resource, move it into a module, or bring something created by hand under Terraform. Older guides tell you to run `terraform state mv` and `terraform import` by hand. Prefer the config-driven blocks instead. They go through the normal plan, review and CI process, and the team can see exactly what happened.

```hcl
# Renamed a resource or moved it into a module
moved {
  from = example_subnet.app
  to   = module.network.example_subnet.this["app"]
}

# Adopt something that already exists
import {
  to = example_bucket.legacy_logs
  id = "acme-legacy-logs"
}

# Stop managing something, but don't delete it (Terraform 1.7+)
removed {
  from = example_bucket.old_reports
  lifecycle {
    destroy = false
  }
}
```

`terraform plan -generate-config-out=generated.tf` will even write a first draft of the resource block for an `import`. Tidy it up before committing, because generated config includes every attribute.

Leave `moved` blocks in place for a while after the change, so anyone with an older copy of the state gets migrated too. Remove them once every environment has been applied.

## State: local, remote and locked

### Local state

By default Terraform writes `terraform.tfstate` next to your code. That's fine for learning and for throwaway experiments. It's not fine for anything shared, because:

- Two people can't safely work on it. There's no locking.
- It lives on one laptop. Lose the laptop, lose track of your infrastructure.
- It contains secrets in plain text, and it's one `git add .` away from being committed.

Add these to `.gitignore` in every Terraform repository, today:

```gitignore
.terraform/
*.tfstate
*.tfstate.*
*.tfplan
crash.log
*.auto.tfvars
override.tf
override.tf.json
*_override.tf
*_override.tf.json
```

Commit `.terraform.lock.hcl`. Don't ignore it.

### Remote state

A remote backend stores state in shared storage that supports locking. The common choices:

| Backend | Storage | Locking |
| --- | --- | --- |
| `s3` | Amazon S3 bucket | Native lock file with `use_lockfile = true` (Terraform 1.11+). DynamoDB locking is deprecated |
| `gcs` | Google Cloud Storage bucket | Built in |
| `azurerm` | Azure Storage blob container | Built in, using blob leases |
| HCP Terraform (`cloud` block) | Managed by HashiCorp | Built in, plus runs, policy and a UI |

Whichever you pick, set the storage up properly:

- **Turn on versioning.** If state is ever corrupted or wrongly overwritten, you can roll back to the previous version. This has saved me more than once.
- **Encrypt it**, ideally with a key you manage, and block public access.
- **Lock down access.** Only the CI identity for that environment should be able to write prod state. Engineers can usually read it.
- **One bucket or container per environment**, in that environment's account or project, if you can. At minimum a separate key per environment and stack.
- **Create the state bucket outside the stack that uses it.** A small bootstrap configuration, or a one-off script, creates the buckets. A stack can't store its state in a bucket it's about to create.

### Locking

When one person runs `apply`, the backend takes a lock so a second `apply` can't run at the same time and corrupt state. If a run is killed halfway, the lock can be left behind, and you'll see an error with a lock ID.

```sh
terraform force-unlock <LOCK_ID>
```

Only do that when you're sure no run is in progress. Check CI first. Unlocking under a live apply is how state gets corrupted.

### Reading another stack's outputs

When you split into several stacks, the `platform` stack needs the network ID from the `network` stack. You can read another stack's outputs with the `terraform_remote_state` data source, but that needs read access to the whole state file, secrets included. A cleaner option is to have the network stack publish what others need somewhere small and specific, like a parameter store or a tagged lookup, and read it with an ordinary data source.

### State commands to know, and use carefully

```sh
terraform state list                  # what Terraform manages
terraform state show 'module.network.example_subnet.this["app"]'
terraform plan -refresh-only          # see drift without changing anything
```

Never edit the state file by hand. If you think you need to, there's almost always a `moved`, `import` or `removed` block that does it safely.

## Versioning: Terraform, providers and modules

Pin versions so the same code produces the same plan next month.

```hcl
# stacks/platform/versions.tf
terraform {
  required_version = "~> 1.11"

  required_providers {
    example = {
      source  = "example/example"
      version = "~> 6.4"
    }
  }
}
```

- `~> 1.11` allows 1.11, 1.12 and later 1.x releases, but not 2.0. `~> 6.4` allows 6.4 and later 6.x, but not 7.0.
- `terraform init` writes the exact provider versions it picked, with checksums, to `.terraform.lock.hcl`. Commit it, so CI and every engineer use the same build.
- Upgrade on purpose: `terraform init -upgrade`, read the provider changelog, run a plan in every environment, then commit the new lock file in its own pull request.
- If engineers use Macs and CI runs on Linux, record checksums for both: `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- Version shared modules with semantic version tags and write a short changelog. A breaking change to a module's inputs is a major version bump.
- Pin the Terraform CLI itself with a version manager such as `tfenv` or `mise`, using a `.terraform-version` or `mise.toml` file in the repository.

Everything here also applies to OpenTofu, the open-source fork, if that's what your organisation uses. The structure is identical.

## Naming and tagging

Pick conventions early and write them in the repository README.

- **Terraform names use snake_case:** `example_subnet.private_app`, `variable "max_nodes"`.
- **Don't repeat the type in the name.** `example_subnet.app`, not `example_subnet.app_subnet`.
- **Cloud resource names use a predictable pattern**, built in one local: `<org>-<env>-<component>`, such as `acme-prod-api`. Watch each cloud's length and character limits.
- **Tag or label everything** with at least environment, owner, cost centre and `managed_by = "terraform"`. Most providers can apply default tags or labels at provider level so you can't forget.
- **Use singular nouns** for modules (`network`, not `networks`) and plural keys for collections (`subnets`).

## Code quality and CI

Terraform is code, so treat it like code. A good pipeline does the same thing on every pull request.

**Locally, before you push:**

```sh
terraform fmt -recursive
terraform validate
tflint --recursive
```

A pre-commit hook that runs these saves a lot of review comments about formatting.

**On every pull request:**

1. `terraform fmt -check -recursive` fails if anything isn't formatted.
2. `terraform init` and `terraform validate` for each stack.
3. A linter such as `tflint` with the plugin for your cloud, which catches things like invalid instance types.
4. A security scanner such as Checkov or Trivy, which flags public buckets, open security groups and unencrypted disks.
5. `terraform test` for modules. Since 1.6, Terraform has a native test framework using `.tftest.hcl` files. Plan-only tests with mocked providers run in seconds and don't touch the cloud.
6. `terraform plan` for each affected environment, with the plan output posted to the pull request for review.

**On merge to main:**

1. Apply to dev automatically.
2. Apply to staging, either automatically or with one approval.
3. Apply to prod with a required approval, from the exact plan that was reviewed.

Two rules make this safe:

- **CI uses short-lived credentials,** through OIDC workload identity federation, not access keys stored as secrets. Each environment has its own identity, and only the prod pipeline's identity can change prod. I explained how to set that up in [Delete the cloud key in your CI pipeline](/blog/workload-identity-federation-ci/).
- **Humans read the plan,** not just the green tick. [Reading a Terraform plan properly](/blog/read-your-terraform-plan/) is its own skill, and worth ten minutes.

Run a scheduled `terraform plan -detailed-exitcode` against each environment every night as well. Exit code 2 means there are changes nobody asked for, which is drift. Someone changed something in the console, and you want to know before the next deploy finds out.

## Mistakes I see beginners make

- **Copy-pasting a folder per environment.** Use modules and tfvars files instead.
- **Running apply from a laptop against prod.** Fine for learning, risky for a team. Make CI the only path to prod.
- **Committing `.tfstate` or secret `.tfvars` files.** Check `.gitignore` before the first commit, not after.
- **One giant state file for everything.** Plans get slow, the blast radius is huge, and every change locks everybody out. Split by lifecycle: network, shared platform, then each application.
- **Modules that wrap a single resource and pass every argument through.** That's a module with no opinion. A good module encodes your standards, like encryption on, public access off, and tags applied.
- **`count` over a list of names.** Use `for_each` with a map.
- **Using `depends_on` everywhere "to be safe".** References already handle ordering, and extra `depends_on` makes plans worse.
- **Unpinned providers.** A new major version can rename arguments, and your next plan fails for reasons unrelated to your change.
- **Ignoring drift.** If the plan shows changes you didn't make, find out why before applying over them.

## A checklist for a new Terraform repository

- `modules/` for child modules, `stacks/` for root modules
- `environments/<env>.tfvars` and `environments/<env>.backend.hcl` for every environment
- Remote backend with versioning, encryption and locking, one state per environment and stack
- `.gitignore` covering state, plans, `.terraform/` and override files
- `required_version` and `required_providers` pinned, `.terraform.lock.hcl` committed
- Every variable and output has a type and a description, with validation where it matters
- Default tags or labels on every provider
- `for_each` for named collections, `count` only for on/off
- `prevent_destroy` and cloud deletion protection on stateful resources
- fmt, validate, tflint, a security scanner and `terraform test` in CI
- Plans posted on pull requests, applies from CI with OIDC credentials, approvals for prod
- Nightly drift detection

## Coming next in this series

This guide is the foundation. The next three articles take the same layout and apply it to a real enterprise landing zone on each of the big clouds, with the account or project structure, state backend, identity setup and first modules you'd build:

- **Terraform on AWS for enterprises:** Organizations and accounts, an S3 state backend with native locking, and OIDC from CI.
- **Terraform on Google Cloud for enterprises:** the resource hierarchy, a GCS state backend, and Workload Identity Federation.
- **Terraform on Azure for enterprises:** management groups and subscriptions, an Azure Storage state backend, and federated credentials.

Get the structure right once, and moving between clouds is mostly a matter of swapping providers and resource types. The habits stay the same.
