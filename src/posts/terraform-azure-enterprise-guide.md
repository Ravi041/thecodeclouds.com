---
title: "Terraform on Azure: how an enterprise should start, and the practices that keep it sane."
description: "Management groups, subscriptions per environment, Azure Verified Modules, a locked-down azurerm state backend, OIDC from CI and a parent/child module layout driven by environments/*.tfvars."
date: 2026-11-19T04:00:00Z
category: Terraform
coverLabel: "Subscriptions first. Code second."
coverCode: "$ az account set -s payments-dev"
coverLogos: "terraform-icon, microsoft-azure"
coverImage: /assets/images/covers/terraform-azure-enterprise-guide.jpg
coverImageAlt: "Terraform cover reading 'Subscriptions first. Code second.', with the Terraform and Microsoft Azure logos."
---
Most Azure Terraform projects that go wrong don't go wrong in the Terraform. They go wrong one level up: every team deploys into one shared subscription, state lives in a storage account someone created by hand with an access key in a pipeline variable, and "dev" and "prod" differ only by a resource group prefix. Terraform faithfully automates the mess.

This guide is the Azure half of the story. The language itself, meta-arguments, the `environments/dev.tfvars` pattern and parent/child modules are covered in the [Terraform best practices and module architecture guide](/blog/terraform-best-practices-module-architecture/). Read that first if `for_each` or a backend block is new to you. Here we cover what changes when the target is Azure and the organisation is bigger than one team.

## Get the Azure hierarchy right before writing code

Azure has four levels you will design around:

| Level | What it is for | Terraform impact |
| --- | --- | --- |
| Tenant (Microsoft Entra ID) | Identities, app registrations, managed identity trust | One per company, rarely touched by app teams |
| Management groups | Policy and RBAC inheritance for groups of subscriptions | Owned by the platform team |
| Subscriptions | Billing, quota and the strongest isolation boundary you get cheaply | One per workload per environment |
| Resource groups | Lifecycle grouping inside a subscription | Created by the stack that owns the resources |

The single most useful decision is **one subscription per workload per environment**: `payments-dev`, `payments-prod`, and so on. A subscription gives you a clean RBAC boundary, separate quota, separate cost reporting and a separate place for policy exceptions. It also means a bad `terraform apply` with dev credentials physically cannot touch production, because the dev identity has no role in the prod subscription.

Resource-group-per-environment inside one subscription looks simpler on day one. By month six you are writing Azure Policy exemptions per resource group and explaining to finance why the prod bill includes dev load tests.

## Separate the platform from the applications

Microsoft's Cloud Adoption Framework splits the estate into two kinds of landing zone, and the split maps neatly onto Terraform repositories:

- **Platform landing zone**: management groups, Azure Policy assignments, the connectivity hub (hub VNet or Virtual WAN, firewall, private DNS zones), central logging, and subscription vending. One platform team owns it.
- **Application landing zones**: the subscriptions where workloads run. Application teams own the Terraform inside them, within the guardrails the platform sets.

Don't write the platform layer from scratch. The [Azure Landing Zones IaC accelerator](https://azure.github.io/Azure-Landing-Zones/accelerator/) bootstraps it with Terraform built on [Azure Verified Modules](https://azure.github.io/Azure-Verified-Modules/) (AVM), including the GitHub or Azure DevOps repository, pipelines, state storage and OIDC identities. It is opinionated, and that is the point: it encodes years of policy and network decisions you would otherwise rediscover one incident at a time.

The piece application teams care most about is **subscription vending**: a module the platform team runs to create a new subscription, place it in the right management group, peer its VNet to the hub, and create the deployment identity with federated credentials. A new team should get a ready subscription from a pull request, not from a ticket.

## Repository layout

Use the same layout as the generic guide, with one root module per stack and environment differences kept in variables:

```text
infra/
├── modules/                 # child modules, owned and versioned by you
│   ├── network/
│   ├── app-service/
│   └── key-vault/
└── stacks/
    └── payments-api/        # the parent (root) module for one deployable stack
        ├── main.tf
        ├── providers.tf
        ├── variables.tf
        ├── outputs.tf
        └── environments/
            ├── dev.tfvars
            ├── dev.backend.hcl
            ├── prod.tfvars
            └── prod.backend.hcl
```

Keep stacks small. A stack is something one team applies together and is happy to plan in under a couple of minutes: "networking for payments" or "payments API", not "everything in the payments subscription". Large stacks make every plan slow and every review terrifying.

## Bootstrap the state backend once, and lock it down

The `azurerm` backend stores state as a blob and uses blob leases for locking, so you don't need a separate lock table. Create the backend before any stack exists, in a dedicated management subscription, usually with the CLI or the landing zone accelerator rather than with the Terraform it will serve:

```sh
az group create --name rg-tfstate-prod --location uksouth

az storage account create \
  --name sttfstateprod001 \
  --resource-group rg-tfstate-prod \
  --sku Standard_ZRS \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --allow-shared-key-access false

az storage account blob-service-properties update \
  --account-name sttfstateprod001 \
  --enable-versioning true \
  --enable-delete-retention true --delete-retention-days 30

az storage container create \
  --name tfstate \
  --account-name sttfstateprod001 \
  --auth-mode login
```

The settings that matter:

- **`--allow-shared-key-access false`** turns off account keys. Every reader and writer must use Microsoft Entra ID, which means every access is tied to an identity and shows up in logs.
- **Blob versioning and soft delete** let you recover a state file someone corrupted or deleted. You will need this once, and you will be very glad.
- **One state account per environment tier** (non-prod and prod at minimum), so the dev pipeline identity has no data-plane access to prod state. State contains secrets in plain text; treat read access to it as read access to production.
- **Network restriction**: once your runners have private connectivity, add a private endpoint and disable public network access.

Then point each environment at its own key with a small backend file:

```hcl
# environments/dev.backend.hcl
resource_group_name  = "rg-tfstate-nonprod"
storage_account_name = "sttfstatenonprod001"
container_name       = "tfstate"
key                  = "payments-api/dev.tfstate"
use_azuread_auth     = true
```

`use_azuread_auth = true` is the line people forget. Without it the backend tries to fetch the account key, which fails (correctly) once shared keys are disabled. The identity running Terraform needs **Storage Blob Data Contributor** on the container, not Contributor on the account.

The backend block in code stays empty, so nothing environment-specific lives in `.tf` files:

```hcl
terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }

  backend "azurerm" {}
}
```

## Configure the provider for an enterprise tenant

```hcl
provider "azurerm" {
  features {}

  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"
  storage_use_azuread             = true
}
```

Three Azure-specific notes:

- **`subscription_id` is mandatory in azurerm 4.x.** Pass it as a variable from the tfvars file so the subscription is visible in code review. Never rely on whatever `az account show` happens to return on someone's laptop.
- **`resource_provider_registrations = "none"`** stops the provider trying to register dozens of resource providers on first run. In a landing zone the platform team registers providers during subscription vending, and your deployment identity shouldn't have permission to do it anyway.
- **`storage_use_azuread = true`** makes the provider use Entra ID for storage data-plane calls, matching the no-shared-key policy you will almost certainly have.

When a brand-new Azure feature isn't in `azurerm` yet, use the `azapi` provider for that one resource rather than shelling out to the CLI from a `local-exec`. AzAPI talks to the ARM REST API directly, so it supports new API versions on day one and still keeps the resource in state.

## Parent and child modules, the Azure way

A child module wraps a single concern with your company's defaults baked in. Where an Azure Verified Module exists for a resource, wrap it rather than rewriting it. AVM resource modules already handle diagnostic settings, private endpoints, role assignments and locks through consistent inputs, so your wrapper only has to set your defaults. Many AVM modules are now built on the `azapi` provider, which is why it sits next to `azurerm` in the provider requirements above. Always read the module's README for the version you pin: AVM modules are still pre-1.0 and their inputs do change between minor versions.

```hcl
# modules/network/main.tf
module "vnet" {
  source  = "Azure/avm-res-network-virtualnetwork/azurerm"
  version = "x.y.z" # pin the exact version you tested; upgrade deliberately

  name          = "vnet-${var.workload}-${var.environment}-${var.location_short}"
  parent_id     = var.resource_group_id # AVM modules take the resource group's ID, not its name
  location      = var.location
  address_space = [var.address_space]
  subnets       = var.subnets
  tags          = var.tags
}
```

```hcl
# modules/network/variables.tf
variable "workload"          { type = string }
variable "environment"       { type = string }
variable "location"          { type = string }
variable "location_short"    { type = string }
variable "resource_group_id" { type = string }
variable "address_space"     { type = string }
variable "tags"              { type = map(string) }

variable "subnets" {
  type = map(object({
    name             = string
    address_prefixes = list(string)
  }))
}
```

The parent module composes child modules and owns the resource group and tags:

```hcl
# stacks/payments-api/main.tf
locals {
  tags = merge(var.tags, {
    workload    = var.workload
    environment = var.environment
    managed-by  = "terraform"
    repo        = "infra/stacks/payments-api"
  })
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${var.workload}-${var.environment}-${var.location_short}"
  location = var.location
  tags     = local.tags
}

module "network" {
  source = "../../modules/network"

  workload          = var.workload
  environment       = var.environment
  location          = var.location
  location_short    = var.location_short
  resource_group_id = azurerm_resource_group.this.id
  address_space     = var.address_space
  subnets           = var.subnets
  tags              = local.tags
}
```

And the environment files carry only what is genuinely different:

```hcl
# environments/dev.tfvars
subscription_id = "00000000-0000-0000-0000-000000000000" # payments-dev
environment     = "dev"
location        = "uksouth"
location_short  = "uks"
workload        = "payments"
address_space   = "10.40.0.0/22"

subnets = {
  app = { name = "snet-app", address_prefixes = ["10.40.0.0/24"] }
  pe  = { name = "snet-pe",  address_prefixes = ["10.40.1.0/24"] }
}

tags = { cost-centre = "cc-1234", owner = "payments-team" }
```

`prod.tfvars` has the prod subscription ID, a non-overlapping address space handed out by the platform team, and anything sized differently. If you find yourself adding `if environment == "prod"` logic inside modules, turn it into an input variable instead, so the difference is visible in the tfvars diff.

Running it locally against dev looks like this:

```sh
cd infra/stacks/payments-api
terraform init -backend-config=environments/dev.backend.hcl
terraform plan -var-file=environments/dev.tfvars -out=dev.tfplan
```

Use `terraform init -reconfigure` when you switch to another environment's backend file in the same directory, or keep a separate checkout per environment.

## No secrets in CI: OIDC with federated credentials

The old pattern is a service principal with a client secret stored in the pipeline. It expires at the worst moment and leaks into logs and laptops. Use workload identity federation instead: a user-assigned managed identity (or app registration) trusts tokens that GitHub Actions or Azure DevOps issue for a specific repository and environment, and no secret exists anywhere.

Create one identity per environment, and if you can, two per environment: a read-only **plan** identity used on pull requests, and an **apply** identity that only the protected `main` branch environment can use.

```sh
az identity create --name id-payments-prod-apply --resource-group rg-identities-prod

az identity federated-credential create \
  --name github-prod \
  --identity-name id-payments-prod-apply \
  --resource-group rg-identities-prod \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:your-org/infra:environment:prod \
  --audiences api://AzureADTokenExchange
```

The `subject` is the security boundary. `environment:prod` means only a job running in the GitHub environment called `prod`, which you protect with required reviewers, can get a token for this identity. A pull request from a feature branch gets a different subject and is refused.

Give the apply identity **Contributor** on its own subscription (plus **Role Based Access Control Administrator** with conditions if the stack creates role assignments), and **Storage Blob Data Contributor** on its state container. Give the plan identity **Reader** and **Storage Blob Data Reader**. Nothing should have Owner.

Then the workflow passes the identity through environment variables that both the provider and the backend understand:

```yaml
# .github/workflows/payments-api.yml (the apply job)
permissions:
  id-token: write
  contents: read

jobs:
  apply-prod:
    runs-on: ubuntu-latest
    environment: prod
    env:
      ARM_USE_OIDC: "true"
      ARM_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
      ARM_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}
      ARM_SUBSCRIPTION_ID: ${{ vars.AZURE_SUBSCRIPTION_ID }}
    defaults:
      run:
        working-directory: infra/stacks/payments-api
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init -backend-config=environments/prod.backend.hcl
      - run: terraform plan -var-file=environments/prod.tfvars -out=prod.tfplan
      - run: terraform apply prod.tfplan
```

The client, tenant and subscription IDs are identifiers, not secrets, so environment variables are fine. Add `use_oidc = true` to the backend file too if you prefer it explicit rather than inherited from `ARM_USE_OIDC`. For how the federated token exchange works under the hood, see [workload identity federation for CI](/blog/workload-identity-federation-ci/).

## Guardrails belong in Azure Policy, not in code review

Code review catches what reviewers notice. Azure Policy catches everything, including changes made in the portal. Have the platform team assign policies at management group level and let Terraform discover them the hard way in dev, not prod:

- **Allowed locations**, so nobody creates a database in a region your data residency rules forbid.
- **Required tags** (`cost-centre`, `owner`, `environment`) with `deny`, and inherit-from-resource-group with `modify`.
- **Deny public network access** on storage, Key Vault, SQL and other PaaS services in production management groups.
- **Deploy diagnostic settings** to the central Log Analytics workspace with `deployIfNotExists`.

Two Terraform consequences to plan for. First, a `deny` policy fails the apply, not the plan, because the plan never calls Azure's policy engine. Run every change in dev first so policy failures surface where they're cheap. Second, `modify` and `deployIfNotExists` policies change resources after Terraform creates them, which shows up as drift on the next plan. Use `lifecycle { ignore_changes = [tags["inherited-tag"]] }` sparingly for the specific attributes a policy owns, rather than ignoring all tags.

## Azure-specific traps worth knowing early

- **Globally unique names.** Storage accounts, Key Vaults, container registries and App Service hostnames are global. Put a short workload code, environment and region in the name, and keep a naming convention module so everyone builds names the same way.
- **Soft delete and purge protection.** A deleted Key Vault or Cognitive Services account is kept for 7 to 90 days, and its name stays reserved. Destroying and recreating with the same name fails. Enable purge protection on production vaults, and don't use `destroy` as a reset button in shared environments.
- **Role assignment propagation.** A role assignment can take a minute or two to apply everywhere. If a resource depends on an identity's new role, add an explicit `depends_on`, and expect the occasional retry.
- **Resource locks.** A `CanNotDelete` lock on production resource groups protects against accidental destroys, including Terraform's. Manage the lock in the platform layer so an app stack can't remove its own safety net.
- **Moves and renames.** Changing a resource's name in Azure usually means replacement. Use `moved` blocks when you refactor addresses in code, and read every plan for `-/+` before approving. The [plan review routine](/blog/read-your-terraform-plan/) applies doubly on Azure.

## A 30-day start for an enterprise

If you are starting from nothing, this order works:

1. **Week 1:** agree the management group hierarchy and subscription-per-workload-per-environment model. Deploy the platform landing zone with the ALZ accelerator into a sandbox tenant or a test management group first.
2. **Week 2:** create the state storage accounts with shared keys disabled, versioning on and private endpoints. Set up the platform repository's pipelines with OIDC identities. Delete every client secret you find.
3. **Week 3:** build subscription vending. Onboard one friendly application team end to end: their subscriptions, identities, a stack using `environments/*.tfvars`, and a pipeline that plans on PR and applies on merge with an approval for prod.
4. **Week 4:** write down what that team tripped on, publish your internal child modules with versions and examples, and open the door to the next three teams.

The order matters more than the speed. Teams that start writing application Terraform before the subscription model and state backend are agreed spend the following quarter migrating state between accounts and untangling shared subscriptions.

## Further reading

- [Terraform best practices and module architecture](/blog/terraform-best-practices-module-architecture/) for the language-level practices this guide builds on.
- [Azure Landing Zones for Terraform](https://azure.github.io/Azure-Landing-Zones/terraform/) and the [AVM module index](https://azure.github.io/Azure-Verified-Modules/indexes/terraform/).
- [Store Terraform state in Azure Storage](https://learn.microsoft.com/azure/developer/terraform/store-state-in-azure-storage) on Microsoft Learn.
- The [azurerm backend reference](https://developer.hashicorp.com/terraform/language/backend/azurerm) for every authentication option.
