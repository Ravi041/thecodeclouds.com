---
title: "Securing and scaling an e-commerce platform on Azure: hub-and-spoke, Entra ID, Key Vault, Defender and two regions"
description: "A production design for an online shop on Azure: Front Door Premium with Private Link, hub-and-spoke networking with Azure Firewall, Entra ID and workload identity, Key Vault, Defender for Cloud with Sentinel, and a two-region failover you can actually run. Two real scenarios, a leaked credential and a region outage, plus four editable draw.io diagrams."
date: 2026-11-20T04:08:00Z
category: Cloud & DevOps
coverLabel: "Lock it down.\nScale it out.\nSurvive a region."
coverCode: "Front Door · hub-spoke · Entra · 2 regions"
coverLogos: "microsoft-azure"
coverImage: /assets/images/covers/azure-ecommerce-security-scaling.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Lock it down. Scale it out. Survive a region.', with the Microsoft Azure logo."
---
An online shop is a strange thing to secure. It has to be wide open to the whole internet, take card payments from strangers, keep customer addresses private, and stay up on the one weekend a year when traffic jumps ten times and every attacker knows you're busy.

This article is the Azure design I'd hand to a team running a mid-size shop: a European retailer doing around 40,000 orders a day, with a catalog of 200,000 products, a web storefront and a mobile app, and a Black Friday peak that's roughly ten times a normal Tuesday. It's built from the same pieces most Azure shops end up with, wired together so that each one covers for the others when something goes wrong.

There are four diagrams, all editable `.drawio` files built with draw.io's own Azure icons, and you can download them at the end. The middle of the article walks through two things that really happen to shops: a credential leaking to a public repository, and an Azure region going down during a sale. For each one you'll see what stops the damage, what notices it, and what the on-call engineer actually does.

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce/azure-shop-hld.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce/azure-shop-hld.svg" alt="High-level design. Shoppers on web and mobile connect to Azure Front Door Premium with a WAF policy using DRS 2.2, bot protection and rate limits. A platform subscriptions box holds Entra ID with Conditional Access and PIM, Entra ID Protection, Azure Policy at management-group scope, Defender for Cloud, Microsoft Sentinel and Log Analytics. Two regions sit below. West Europe is primary and serves all traffic through Front Door priority 1; North Europe is a warm standby at priority 2. Each region has a hub VNet with Azure Firewall Premium, Azure Bastion and DNS Private Resolver; a shop spoke VNet with an internal load balancer and Private Link service in front of AKS across three zones and an ACR replica; and a data spoke with private endpoints only for Azure SQL, Cosmos DB, Azure Managed Redis, Service Bus, Key Vault and Storage. Front Door reaches each region over Private Link. Traffic from app to data is forced through the hub firewall. Green lines show cross-region replication: a SQL failover group, Cosmos DB in two regions, and Storage RA-GZRS with a Key Vault per region and an ACR geo-replica." width="1500" height="1030" loading="lazy"></a><figcaption>The whole shop on one page: a global edge, a hub-and-spoke network in each of two regions, and identity and detection wrapped around everything.</figcaption></figure>

## The short version

- **Put Front Door Premium in front of everything, and give your origins no public IP at all.** Front Door reaches AKS through Private Link, so the WAF can't be bypassed by someone who finds your origin address.
- **Use hub-and-spoke in each region.** The hub owns the firewall, Bastion and DNS. Spokes hold the app and the data. Spoke-to-spoke traffic goes through the firewall, so every flow is logged and allowed on purpose.
- **Turn off public network access on every data service.** Azure SQL, Cosmos DB, Redis, Service Bus, Key Vault and Storage are reachable only through private endpoints. A stolen token alone is then not enough.
- **No secrets for workloads.** Pods use Microsoft Entra Workload ID with a managed identity per service. People use Conditional Access, phishing-resistant MFA and PIM with no standing Owner roles.
- **Key Vault per app, per region, per environment,** with Azure RBAC, purge protection, and secrets mounted through the Secrets Store CSI driver.
- **Defender for Cloud plans on everything that holds data,** alerts into Microsoft Sentinel, and a playbook that disables an identity and rotates its secrets without waiting for a human.
- **Two regions, with a failover you've rehearsed.** Front Door priority routing, a SQL failover group with customer-managed failover, Cosmos DB in both regions, and a runbook the on-call engineer has actually run in a game day.

## The shop we're building for

It's worth being specific, because the right design depends on the workload.

- **Storefront, search and product pages:** read-heavy, cacheable, and where most of the traffic goes. Losing these for a minute is annoying.
- **Cart:** written often, read often, needs to survive a region failure. Losing a cart loses a sale.
- **Checkout and orders:** fewer requests but every one of them is money. Must not double-charge, must not lose a confirmed order.
- **Payments:** handled by an external payment service provider (PSP). The shop never sees a full card number, which keeps most of the platform out of PCI DSS card-data scope. The shop talks to the PSP over one allowed outbound route.
- **Back office:** finance reports, warehouse integration over ExpressRoute to an on-premises ERP, and a support tool.

Data lands in the store that suits it: orders in **Azure SQL Database** (relational, transactional, needs a single source of truth), catalog and carts in **Azure Cosmos DB** (fast reads in every region, flexible schema), sessions and hot product data in **Azure Managed Redis**, order events on **Service Bus**, and images in **Blob Storage** behind Front Door's cache.

## Landing zone first: subscriptions and policy

Before any of the network exists, set up the containers it lives in. If you've read the [Terraform on Azure enterprise guide](/blog/terraform-azure-enterprise-guide/), this will look familiar.

- A **management group** for the shop, with child groups for `platform`, `prod` and `nonprod`.
- **Separate subscriptions** for connectivity (the hubs), shop-prod (the AKS spokes), data-prod (the data spokes), security (Sentinel and the Log Analytics workspace) and the same split for non-prod. A subscription is the strongest boundary Azure gives you for blast radius, quotas and access.
- **Azure Policy assigned at the management group,** not per subscription, so a new subscription is compliant from its first minute. The ones that matter most for this design:
  - Deny public network access on Key Vault, SQL, Cosmos DB, Storage, Service Bus and Redis.
  - Key vaults must use the RBAC permission model and have purge protection.
  - DeployIfNotExists: create the private DNS record when a private endpoint is made, and send diagnostic logs to the central workspace.
  - Deny public IPs on network interfaces in spoke subscriptions.
  - Enable the Defender for Cloud plans listed later.

Policy is what keeps the design true a year later, when someone new is in a hurry. Reviews catch some things; a deny effect catches all of them.

## The network: hub-and-spoke in each region

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce/azure-shop-network.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce/azure-shop-network.svg" alt="Network low-level design for West Europe. The hub VNet 10.10.0.0/22 in the connectivity-prod subscription has AzureFirewallSubnet 10.10.0.0/26 with Azure Firewall Premium at 10.10.0.4 across three zones doing network and application rules, IDPS, TLS inspection and SNAT from a public IP prefix; AzureBastionSubnet 10.10.0.64/26 with Bastion Standard using Entra sign-in and PIM; GatewaySubnet 10.10.0.128/27 with an ExpressRoute gateway to the warehouse ERP; DNS resolver subnets with a DNS Private Resolver inbound endpoint at 10.10.1.4 that every VNet uses as its DNS server; and private DNS zones for SQL, Cosmos DB, Managed Redis, Service Bus, Key Vault, Blob, the AKS private API and Container Registry, created by Azure Policy. The shop spoke 10.11.0.0/16 has snet-ilb-pls with an internal load balancer at 10.11.8.10 and a Private Link service, AKS system and user pool subnets, and a private endpoint subnet for Key Vault and ACR. A route table sends 0.0.0.0/0 and 10.12.0.0/22 to the firewall. A note lists AKS settings: private API server, Entra ID auth with Azure RBAC, Azure CNI Overlay with pods in 192.168.0.0/16, Cilium network policy, OIDC issuer and workload identity, outbound type userDefinedRouting, and the Defender for Containers sensor. The data spoke 10.12.0.0/22 has one private endpoint subnet with network policies on, holding SQL, Cosmos DB, Redis, Service Bus, Key Vault and Blob Storage endpoints. A bottom panel explains four packet walks: shopper to storefront via Front Door and Private Link, checkout pod to SQL through the firewall, pod to payment provider through a firewall application rule, and an engineer reaching the cluster through PIM and Bastion." width="1500" height="950" loading="lazy"></a><figcaption>One region in detail. North Europe is a copy with 10.20, 10.21 and 10.22 ranges.</figcaption></figure>

### Why hub-and-spoke, and why the firewall sits in the middle

The hub is a VNet that holds the things every workload shares: Azure Firewall, Bastion, the DNS Private Resolver and the ExpressRoute gateway. Each workload gets its own spoke VNet, peered to the hub.

VNet peering isn't transitive. The shop spoke and the data spoke are both peered to the hub but not to each other, so there is no direct path between them. A route table on the shop spoke sends `0.0.0.0/0` and the data range to the firewall's private IP. Now every packet from a pod to a database crosses the firewall, which allows it by rule and logs it. If someone compromises a pod, the firewall logs show exactly what it tried to reach.

You could peer the spokes directly and rely on NSGs. It's cheaper and has lower latency. For a shop holding customer data, I'd rather pay for the firewall and have one place where east-west traffic is decided and recorded.

### Let Azure Virtual Network Manager hold the topology

Hand-building peerings and route tables works for three VNets and falls apart at thirty. **Azure Virtual Network Manager (AVNM)** lets you declare the shape instead:

- A **connectivity configuration** with topology "hub and spoke", the hub VNet, and a network group of spokes. New spokes added to the group get peered automatically.
- A **routing configuration** that puts `0.0.0.0/0 → Azure Firewall` on every spoke subnet, using the firewall's private IP as next hop.
- **Security admin rules** that deny inbound internet traffic to every spoke. These are evaluated before NSGs, so an application team can't open port 22 to the world by editing their own NSG.

### The IP plan

| Range | What it is |
|---|---|
| `10.10.0.0/22` | West Europe hub |
| `10.11.0.0/16` | West Europe shop spoke (AKS nodes, ILB, private endpoints) |
| `10.12.0.0/22` | West Europe data spoke (private endpoints only) |
| `10.20.0.0/22`, `10.21.0.0/16`, `10.22.0.0/22` | The same three in North Europe |
| `192.168.0.0/16` | AKS pod CIDR (Azure CNI Overlay), reused in both clusters, never routed |
| `10.0.0.0/12` | On-premises, already in use |

Overlay networking for pods means a 60-node cluster running 3,000 pods uses a `/22` of VNet space for nodes, not tens of thousands of VNet IPs for pods. Pod traffic leaving the node is translated to the node IP, which keeps firewall rules readable too.

### Front Door Premium and Private Link

The storefront has no public IP. Here's the path a shopper's request takes:

1. DNS sends `www.shop.example` to Front Door, which terminates TLS at the nearest edge location.
2. The **WAF policy** runs: the Microsoft Default Rule Set (DRS 2.2 is the current recommendation), the bot manager rule set, and custom rules. Custom rules run first. Ours rate-limit `/account/login` and `/checkout` per client IP, and geo-filter the admin path.
3. Front Door picks an origin from the origin group. Each origin is a **Private Link service** in front of the AKS internal load balancer. Front Door Premium creates a managed private endpoint to it; you approve the connection once, in the Private Link Center.
4. The request lands on the ingress controller in AKS, and from there on the storefront pods.

Because the internal load balancer isn't reachable from the internet, nothing can skip the WAF. This is the main reason to pay for Premium over Standard: Private Link origins are Premium-only, and they remove a whole class of "attacker found the origin" problems.

Two rules from the docs that people trip on: you can't mix public and private origins in the same origin group, and with Private Link enabled the certificate subject name check is mandatory, so the ingress certificate must match the origin host name.

### Private endpoints and DNS

Every data service has public network access set to **Disabled** and a private endpoint in the data spoke. For that to work, name resolution has to return the private IP:

- One set of **private DNS zones** (`privatelink.database.windows.net`, `privatelink.documents.azure.com`, `privatelink.redis.azure.net` for Azure Managed Redis, `privatelink.vaultcore.azure.net` and so on), linked to the hub.
- A **DNS Private Resolver** in the hub. Every VNet uses its inbound endpoint as DNS server, and an outbound ruleset forwards the corporate domain to on-premises DNS.
- An Azure Policy with DeployIfNotExists that writes the A record into the right zone whenever someone creates a private endpoint.

One detail that bites: traffic from the firewall to a private endpoint should be SNATed (application rules always do this; for network rules, configure SNAT for private ranges), and the private endpoint subnet should have **network policies enabled** so NSGs and UDRs apply to it. Without that, the return path can skip the firewall and connections time out in ways that look random.

### Egress: one door out

AKS uses `outboundType: userDefinedRouting`, so the cluster gets no public IP of its own. Every packet to the internet hits Azure Firewall, which allows:

- The FQDNs AKS itself needs (Azure Firewall has an `AzureKubernetesService` FQDN tag for this).
- `api.psp.example:443` from the payments namespace only, matched with an IP group for the node subnet and, if you use it, a per-namespace egress gateway.
- The carrier and tax APIs the shop calls.

Everything else is denied and logged. When a compromised dependency tries to phone home, it fails, and you get a log line with its destination.

## Identity: people and workloads

Most breaches start with an identity, not a network. In this design there are two kinds, and they're treated very differently.

### People

- **Conditional Access** requires phishing-resistant MFA (FIDO2 keys or Windows Hello) and a compliant device for anyone touching the Azure portal, CLI or Bastion.
- **Privileged Identity Management (PIM)** means nobody holds Owner or Contributor on prod permanently. Engineers activate a role for one to four hours with a reason, and the activation is logged. For subscription Owner, a second person approves.
- **Entra ID Protection** feeds user risk into a risk-based Conditional Access policy with "Require risk remediation". If a user's password shows up in a breach list, they're made to change it and their existing sessions are revoked.
- **Two break-glass accounts,** excluded from Conditional Access, with long random passwords in a safe, and an alert that fires the moment either signs in.

The same principle shows up in [why an explicit deny wins over an allow](/blog/cloud-iam-explicit-deny/): access is a set of layered decisions, and you want each layer to be able to say no on its own.

### Workloads

The checkout service needs to read a Key Vault secret, write to SQL and read Cosmos DB. It does all three without a password:

1. The AKS cluster has the **OIDC issuer** enabled and the **workload identity** add-on.
2. Each service has its own Kubernetes service account and its own **user-assigned managed identity**, linked by a **federated identity credential** whose subject is `system:serviceaccount:checkout:checkout-sa`.
3. The pod gets a short-lived Kubernetes token, exchanges it for a Microsoft Entra token, and calls Azure with that.
4. Azure RBAC on the target decides: `Key Vault Secrets User` on one vault, an Entra-only database user in SQL, a Cosmos DB data-plane role definition on one database.

Nothing in Git, nothing in a pipeline variable, nothing to rotate. This is the same token-exchange idea as [workload identity federation in CI](/blog/workload-identity-federation-ci/), applied inside the cluster.

```bash
# One identity per service, trusted only for one service account in one cluster
az identity create -g rg-shop-prod-weu -n id-checkout
AKS_OIDC=$(az aks show -g rg-shop-prod-weu -n aks-shop-weu --query oidcIssuerProfile.issuerUrl -o tsv)

az identity federated-credential create \
  --name fc-checkout-weu \
  --identity-name id-checkout -g rg-shop-prod-weu \
  --issuer "$AKS_OIDC" \
  --subject system:serviceaccount:checkout:checkout-sa \
  --audiences api://AzureADTokenExchange

# Read secrets from one vault, nothing else
az role assignment create --assignee "$(az identity show -g rg-shop-prod-weu -n id-checkout --query principalId -o tsv)" \
  --role "Key Vault Secrets User" \
  --scope "$(az keyvault show -n kv-shop-weu --query id -o tsv)"
```

Shopper accounts are a separate problem. If you're building sign-in for customers rather than staff, that's Microsoft Entra External ID or your own identity provider, kept in its own tenant, and not mixed with the workforce tenant your engineers use.

## Secrets and keys with Key Vault

Even with workload identity, some secrets remain: the PSP API key, the carrier API token, TLS certificates. They live in Key Vault, set up like this:

- **One vault per application, per region, per environment.** A vault is an access boundary. One shared vault means one role assignment gives away everything.
- **Azure RBAC permission model,** not access policies. RBAC assignments show up in the same place as every other permission and can be governed by PIM.
- **Soft delete** (on by default, 90 days) and **purge protection** on. With purge protection, nobody, not even a Global Administrator, can permanently delete the vault or its secrets before the retention period ends. That's what you want when an attacker with stolen admin rights decides to cause damage on their way out.
- **Expiry dates and rotation.** Every secret has an expiry. Certificates auto-renew. The PSP key rotates on a schedule with two keys active, so rotation never causes an outage.
- **Private endpoint only,** public network access Disabled.

Pods read secrets through the **Secrets Store CSI driver** with the workload identity above, so a secret appears as a file in the pod and can be rotated without a redeploy:

```yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: checkout-secrets
  namespace: checkout
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: "<client id of id-checkout>"
    keyvaultName: kv-shop-weu
    tenantId: "<tenant id>"
    objects: |
      array:
        - |
          objectName: psp-api-key
          objectType: secret
```

For data at rest, Azure SQL, Cosmos DB and Storage are encrypted by default with Microsoft-managed keys. If your auditors require customer-managed keys, put them in a separate vault with purge protection, because a deleted key makes the data unreadable. [Envelope encryption](/blog/cloud-kms-envelope-encryption/) explains why the key never leaves the vault.

## Detection: Defender for Cloud and Sentinel

Prevention fails eventually. Detection is what turns a breach into an incident report instead of a news story.

Turn on the **Defender for Cloud** plans that match what you run:

| Plan | What it watches here |
|---|---|
| Defender CSPM | Misconfigurations and attack paths across all subscriptions |
| Defender for Containers | AKS runtime threats, image vulnerabilities in ACR |
| Defender for Key Vault | Unusual access to vaults, access from TOR or suspicious IPs |
| Defender for Resource Manager | Suspicious control-plane operations |
| Defender for Databases (Azure SQL, Cosmos DB) | SQL injection attempts, anomalous logins and data access |
| Defender for Storage | Malware in uploads, unusual access to blob containers |
| Defender for App Service / Servers | Only if you run them |

Send everything to one **Log Analytics** workspace in the security subscription: Entra sign-in logs (including service principal and managed identity sign-ins), Azure Activity logs, Key Vault, Front Door and Firewall diagnostic logs, and AKS audit logs. Then connect **Microsoft Sentinel** to that workspace and enable the Defender for Cloud connector, so Defender alerts become Sentinel incidents next to everything else.

The last piece is **automation**. A Sentinel playbook (a Logic App with its own managed identity) can disable a service principal, revoke a user's sessions, rotate secrets and add an IP to the Front Door WAF block list. Humans still investigate; the playbook makes sure the door is shut while they do.

## Scenario 1: a client secret leaks to a public repository

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce/azure-shop-identity-detection.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce/azure-shop-identity-detection.svg" alt="Identity, secrets and detection scenario. The left column shows how the shop should authenticate: staff go through Conditional Access with phishing-resistant MFA and compliant devices, then PIM with no standing Owner and one-to-four-hour activation, then scoped Azure RBAC; risk-based policy forces risk remediation and revokes sessions. Workloads authenticate from a checkout pod service account to a managed identity with a federated credential, then Entra ID issues a one-hour token used for SQL with Entra-only auth, Cosmos DB with data-plane RBAC and local auth off, and Key Vault with Secrets User on one vault. The middle column is the attack: at T+0 a client secret for the legacy sp-reporting app is pushed to a public GitHub repo; at T+4 minutes the attacker gets a token from a TOR exit node; at T+5 minutes a call to list Key Vault secrets fails with 403 because public network access is disabled; at T+6 minutes the attacker uses Reader on data-prod to enumerate resources and the SQL public endpoint refuses; later Entra ID Protection raises a leaked credentials risk. The right column shows Defender for Cloud with KV_SuspiciousIPAccessDenied and Defender for Resource Manager, Entra ID Protection, and Log Analytics feeding Microsoft Sentinel, which runs a Logic App playbook to disable the service principal, rotate secrets it could read, block the IP on the Front Door WAF and page on-call. A bottom panel lists what held, what detected it, what was missing and the fix." width="1500" height="965" loading="lazy"></a><figcaption>The leaked-secret incident, from the push to the clean-up.</figcaption></figure>

Every shop has one. Ours is `sp-reporting`, a service principal created three years ago for a finance report. It has a client secret valid for two years and Reader on the data subscription, plus `Key Vault Secrets User` on the data vault so it can fetch a database connection string. A contractor copies the report script into a personal GitHub repository to work on it at home. The repository is public.

**What happens next:**

1. Within minutes, automated scanners find the secret. Someone uses it from a TOR exit node to request a token. The secret is valid, so Entra ID issues the token. This is the uncomfortable part: authentication succeeded.
2. The attacker calls `kv-data-weu` to list secrets. The vault has public network access disabled. The request comes from the internet, so Key Vault answers **403**, whatever the token says.
3. They use the Reader role on Azure Resource Manager to list resources. They find the SQL server and try to connect. Public network access is disabled there too. Refused.
4. **Defender for Key Vault** raises `KV_SuspiciousIPAccessDenied`: access denied from an IP Microsoft threat intelligence flags as suspicious. Defender for Resource Manager may flag the enumeration. Both alerts flow into Sentinel.
5. Separately, **Entra ID Protection** matches the secret it found on GitHub against valid credentials in your tenant and raises a **Leaked Credentials** risk on the workload identity. This is an offline detection, so it can arrive later than the attacker.
6. Sentinel correlates these with the service principal sign-in logs into one high-severity incident. The playbook disables `sp-reporting`, removes all its credentials, and opens a ticket.

The on-call engineer then answers one question: did the attacker get anything? Two queries settle it.

```kusto
// Where did sp-reporting sign in from in the last 7 days, and did it succeed?
AADServicePrincipalSignInLogs
| where TimeGenerated > ago(7d)
| where ServicePrincipalName == "sp-reporting"
| summarize attempts = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated)
    by IPAddress, ResultType, ResourceDisplayName
| order by firstSeen asc
```

```kusto
// Did any Key Vault call from those IPs succeed?
AzureDiagnostics
| where TimeGenerated > ago(7d)
| where ResourceProvider == "MICROSOFT.KEYVAULT"
| where CallerIPAddress in ("<attacker IPs from the query above>")
| project TimeGenerated, Resource, OperationName, ResultSignature, requestUri_s
```

In this case every data-plane call was refused, so no secret was read. If any had succeeded, the next step is to rotate every secret that identity could read, not only the ones it did read, because logs can be incomplete.

**What held:** the network. A valid token wasn't enough, because the request also had to come from inside a VNet. That's the value of turning off public network access everywhere: it's a second, independent check that doesn't care how good the attacker's credentials are.

**What was missing:** the secret itself, and the lack of a location check on it. Conditional Access for workload identities (it needs a Workload ID Premium licence) can block token requests for a service principal from outside known IP ranges, or when ID Protection marks it risky. With that in place, step 1 fails.

**What changed afterwards:**

- The reporting job moved into AKS with workload identity. No secret exists any more.
- An Entra app management policy now blocks new client secrets on app registrations; certificates or federated credentials only.
- GitHub push protection rejects commits that contain secrets.
- A quarterly access review lists every service principal with a credential and an owner.

The same layers handle the human version. If an engineer's password is phished, risk-based Conditional Access forces remediation and revokes sessions, the phishing-resistant MFA requirement means a password alone doesn't get in, and PIM means there's no standing Owner role to steal anyway.

## Scaling for a sale

Security that falls over under load isn't security, it's an outage. Here's how each layer grows for Black Friday.

- **Front Door caches** product pages, images and search suggestions at the edge for short periods (30 to 120 seconds is plenty for prices that change hourly). Cache hit ratio is the cheapest capacity you'll ever buy.
- **WAF rate limits** on `/account/login`, `/checkout` and the search API protect the expensive endpoints from bots and credential stuffing. Set them from real traffic, in Detection mode first, then Prevention.
- **AKS** runs the user pool across three availability zones. The **Horizontal Pod Autoscaler** scales on requests per second (from Prometheus metrics) rather than CPU, and the order workers scale on Service Bus queue depth. The **cluster autoscaler** adds nodes, 6 to 60 in our case. Pre-scale the night before: set a higher minimum so you're not waiting for nodes at 9:00.
- **Cosmos DB** uses autoscale throughput with a sensible partition key: `/cartId` for carts and `/categoryId` plus a synthetic suffix for the catalog, so one hot category doesn't land on one physical partition. Check the max RU/s setting before the sale, because autoscale won't go past it.
- **Azure SQL** for orders runs on a zone-redundant tier sized for peak, with read-only reporting sent to the failover group's read-only listener so finance queries don't compete with checkout.
- **Azure Managed Redis** holds sessions and the hot product cache. Size it for memory at peak, not average.
- **Service Bus Premium** decouples checkout from fulfilment. If the warehouse integration slows down, orders queue instead of failing.
- **Load test** with Azure Load Testing two weeks before, at 1.5 times expected peak, with the WAF on. The WAF is part of the system; testing without it tests a different system.

## Geo-redundancy: deciding what fails over, and how

Zones protect you from a data centre failing. Regions protect you from a whole region failing, which is rare but does happen. The design runs **active / warm standby**: West Europe takes all traffic, North Europe runs the same images on a small cluster with all data already replicated, ready to scale.

| Component | West Europe | North Europe | How it fails over |
|---|---|---|---|
| Front Door | Origin priority 1 | Origin priority 2 | Automatic, on health probes |
| AKS | Full size, 3 zones | Same images, minimum nodes | Autoscaler grows it |
| Azure SQL (orders) | Primary | Geo-secondary in a failover group | Customer-managed: forced failover by runbook |
| Cosmos DB (catalog, carts) | Write region | Read region | Forced failover of the write region by runbook |
| Redis (sessions) | Active | Separate cache, empty | None: sessions are disposable |
| Service Bus | Namespace | Separate namespace | Outbox in SQL re-sends unacknowledged events |
| Key Vault | `kv-*-weu` | `kv-*-neu`, same secrets | Each region reads its own vault |
| Storage (images) | RA-GZRS primary | Readable secondary | Front Door reads the secondary endpoint |
| ACR | Primary | Geo-replica | Nothing to do |

Two choices deserve a word:

**Customer-managed failover for SQL.** Failover groups support Microsoft-managed failover, but Microsoft triggers it only for widespread outages, with a minimum one-hour grace period, and the docs recommend customer-managed. For a shop, an hour without checkout is too long. With customer-managed failover the typical RTO is under a minute once you decide to fail over. Applications connect to the failover group's read-write listener, `fog-shop.database.windows.net`, which is a DNS CNAME with a 30-second TTL, so the connection string never changes.

**Forced failover for Cosmos DB rather than waiting.** Service-managed failover exists, but Microsoft's reliability guide notes that declaring an outage and triggering it can take an hour or more. Single-write-region accounts with Session consistency have an RPO of under 15 minutes in a region outage. Carts can tolerate that. If they couldn't, you'd look at per-partition automatic failover or multiple write regions, each with its own trade-offs.

## Scenario 2: West Europe goes down during a sale

<figure class="diagram wide"><a href="/assets/diagrams/azure-ecommerce/azure-shop-region-failover.svg" title="Open the full-size diagram"><img src="/assets/diagrams/azure-ecommerce/azure-shop-region-failover.svg" alt="Region failover runbook. A six-step timeline: 1, detect in about one to two minutes as Front Door probes /healthz/deep every 30 seconds and marks West Europe unhealthy when three of four samples fail; 2, route automatically to the priority 2 origin in North Europe so browsing works at once; 3, scale in about five to eight minutes as HPA and the cluster autoscaler grow nodes from 6 to 40 while WAF rate limits and a queue page protect checkout; 4, promote data in under a minute each with forced failover of the SQL failover group and the Cosmos DB write region; 5, replay events from the order outbox to Service Bus with idempotent consumers; 6, fail back days later with a planned failover. Below, shoppers reach Front Door Premium whose origin group lists West Europe priority 1 and North Europe priority 2. West Europe is marked down: AKS unreachable, SQL old primary offline, Cosmos DB old write region, Redis sessions lost, Service Bus backlog stuck. North Europe now serves all traffic over Private Link: AKS scaled to 40 nodes, SQL new primary, Cosmos DB new write region, Redis cold and refilling, Service Bus receiving the outbox replay, its own Key Vault, Storage reading from the RA-GZRS secondary and ACR images already present. Notes list what shoppers saw and the targets: RTO 15 minutes for checkout, RPO of at most one minute for orders and zero for payments." width="1500" height="790" loading="lazy"></a><figcaption>The failover runbook, with the timings you should expect if you've rehearsed it.</figcaption></figure>

It's 11:40 on Black Friday. West Europe has a networking incident; your services there are up but unreachable. Here's what happens, minute by minute.

**Minute 0 to 2: Front Door notices.** The origin group probes `/healthz/deep` every 30 seconds from many edge locations. That endpoint checks the pod can reach SQL, Redis and Cosmos DB, so it fails when the region's dependencies fail, not only when the pod is dead. With a sample size of 4 and 3 successes required, West Europe is marked unhealthy within a couple of probe rounds and Front Door sends everything to North Europe.

**Minute 2 to 8: North Europe scales.** Browse and search work immediately, because catalog reads come from the local Cosmos DB replica and images from the Storage secondary. The HPA sees requests per second climb and adds pods; the cluster autoscaler adds nodes. While it warms, WAF rate limits on `/checkout` and a waiting page keep the cluster from being flattened.

**Minute 3 to 6: on-call promotes the data.** Checkout is failing, because writes still go to the SQL primary and Cosmos DB write region in West Europe. The on-call engineer checks Azure Service Health and Resource Health, confirms it's regional, and runs the runbook:

```bash
# Promote the North Europe SQL server. --allow-data-loss = forced failover,
# needed when the primary can't be reached to synchronise first.
az sql failover-group set-primary \
  --name fog-shop \
  --resource-group rg-data-prod-neu \
  --server sql-shop-neu \
  --allow-data-loss

# Make North Europe the Cosmos DB write region
az cosmosdb failover-priority-change \
  --name cosmos-shop \
  --resource-group rg-data-prod \
  --failover-policies northeurope=0 westeurope=1
```

Within about a minute the read-write listener points at North Europe, and checkout recovers.

**Minute 6 onwards: tidy up.** Orders confirmed in SQL but whose events didn't reach Service Bus are re-sent by the outbox processor. Consumers are idempotent on order ID, so a duplicate event doesn't ship a parcel twice. Shoppers who were signed in have to sign in again, because Redis sessions aren't replicated. Their carts survived, because carts live in Cosmos DB.

**Days later: fail back on your terms.** When West Europe is healthy, the old primary has already reconnected as a secondary. Run a planned failover (without `--allow-data-loss`) at a quiet hour, swap the Cosmos DB priorities back, and restore Front Door priorities.

The thing that makes this work isn't any one service. It's that the team has done it before. Run a **game day** every quarter in non-prod and once a year in prod at a quiet hour: drop the West Europe origin in Front Door, fail over SQL and Cosmos DB, and time each step. Azure Chaos Studio can inject the faults. The first game day always finds something: a hard-coded region in a config file, a secret only in the West Europe vault, a firewall rule missing in the North Europe hub.

## Problems you'll hit, and what to do about them

1. **Private endpoint DNS resolves to the public IP.** Usually the VNet isn't using the DNS Private Resolver, or the zone isn't linked. Check with `nslookup` from a pod, not from your laptop.
2. **Connections to private endpoints time out at random.** Asymmetric routing through the firewall. SNAT at the firewall and enable network policies on the private endpoint subnet.
3. **Front Door origin connection stuck in "Pending".** Someone has to approve the private endpoint connection on the Private Link service. Automate it in your pipeline, or the next region rebuild will stall on it.
4. **AKS can't pull images or reach Entra ID after locking egress.** The firewall needs the `AzureKubernetesService` FQDN tag and the required endpoints. Test egress rules in non-prod with the same firewall policy.
5. **The WAF blocks real customers on day one.** Run new rule sets in Detection mode for a week, read the logs, add precise exclusions, then switch to Prevention. Never turn the whole rule set off.
6. **The secondary region drifts.** A secret, a role assignment or a firewall rule exists only in the primary. Deploy both regions from the same Terraform with region as a variable, and diff them in CI.
7. **SQL failover works, the app doesn't reconnect.** Connection pools hold stale connections. Use the failover group listener, a short connection lifetime and retry logic with backoff.
8. **Cosmos DB hot partition during the sale.** A bad partition key shows up as 429s on one partition while total RU/s look fine. Fix the key before the sale; you can't fix it during one.
9. **Purge protection blocks your teardown script.** That's the point. Don't reuse vault names in ephemeral environments; add a random suffix.
10. **Defender alert fatigue.** Route informational alerts away from on-call, tune suppression rules for known scanners, and review the top ten alert types monthly.
11. **Break-glass accounts that don't work when needed.** Test sign-in quarterly and alert on every use.
12. **Cost surprises.** Firewall Premium, Front Door Premium, Defender plans and a warm second region add up. Price them up front and show the cost of an hour of checkout downtime next to them.

## A checklist before go-live

- Management groups, subscriptions per environment and function, Policy assigned at the management group
- Front Door Premium with WAF in Prevention, Private Link origins, no public IPs on origins
- Hub-and-spoke in both regions managed by AVNM, all spoke traffic through Azure Firewall
- Public network access disabled on every data service, private DNS zones linked and auto-populated
- AKS: private API, Entra ID auth, workload identity, userDefinedRouting egress, network policy default deny
- No standing privileged roles; PIM with approval for Owner; phishing-resistant MFA; two tested break-glass accounts
- Key Vault per app per region with RBAC, purge protection, expiry dates and rotation
- Defender plans on, all logs in one workspace, Sentinel incidents, at least one tested playbook
- SQL failover group with customer-managed failover, Cosmos DB in both regions, Storage RA-GZRS
- A written failover runbook, rehearsed in a game day, with timings recorded

## Download the diagrams

All four diagrams are editable draw.io files using the Azure icons that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the names, regions and ranges to match your estate.

- [All four diagrams in one file (4 pages)](/assets/diagrams/azure-ecommerce/azure-ecommerce-security-scaling.drawio)
- [High-level design](/assets/diagrams/azure-ecommerce/azure-shop-hld.drawio)
- [Network LLD: hub, spokes, private endpoints and DNS](/assets/diagrams/azure-ecommerce/azure-shop-network.drawio)
- [Identity, secrets and detection: the leaked-secret scenario](/assets/diagrams/azure-ecommerce/azure-shop-identity-detection.drawio)
- [Region failover runbook](/assets/diagrams/azure-ecommerce/azure-shop-region-failover.drawio)

The names, address ranges and timings are examples. Check current SKUs, limits, regional availability and prices for your own regions before you build.

## References

- [Hub-spoke network topology in Azure](https://learn.microsoft.com/azure/architecture/networking/architecture/hub-spoke)
- [Deploy hub-and-spoke with Azure Firewall using Azure Virtual Network Manager](https://learn.microsoft.com/azure/virtual-network-manager/how-to-deploy-hub-spoke-topology-with-azure-firewall)
- [Secure your origin with Private Link in Azure Front Door Premium](https://learn.microsoft.com/azure/frontdoor/private-link)
- [Front Door health probes](https://learn.microsoft.com/azure/frontdoor/health-probes) and [traffic routing methods](https://learn.microsoft.com/azure/frontdoor/routing-methods)
- [Azure Front Door WAF DRS rule groups and rules](https://learn.microsoft.com/azure/web-application-firewall/afds/waf-front-door-drs)
- [Azure Private Endpoint private DNS zone values](https://learn.microsoft.com/azure/private-link/private-endpoint-dns)
- [Use Microsoft Entra Workload ID with AKS](https://learn.microsoft.com/azure/aks/workload-identity-overview)
- [Key Vault provider for Secrets Store CSI Driver: identity access](https://learn.microsoft.com/azure/aks/csi-secrets-store-identity-access)
- [Key Vault soft-delete and purge protection](https://learn.microsoft.com/azure/key-vault/general/soft-delete-overview)
- [Securing workload identities with ID Protection](https://learn.microsoft.com/entra/id-protection/concept-workload-identity-risk)
- [Conditional Access for workload identities](https://learn.microsoft.com/entra/identity/conditional-access/workload-identity)
- [Revoke user access in Microsoft Entra ID](https://learn.microsoft.com/entra/identity/users/users-revoke-access)
- [Alerts for Azure Key Vault (Defender for Cloud)](https://learn.microsoft.com/azure/defender-for-cloud/alerts-azure-key-vault)
- [Ingest Defender for Cloud alerts into Microsoft Sentinel](https://learn.microsoft.com/azure/sentinel/connect-defender-for-cloud)
- [Failover groups for Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/failover-group-sql-db)
- [Business continuity in Azure SQL Database (RTO and RPO)](https://learn.microsoft.com/azure/azure-sql/database/business-continuity-high-availability-disaster-recover-hadr-overview)
- [Reliability in Azure Cosmos DB](https://learn.microsoft.com/azure/reliability/reliability-cosmos-db) and [consistency levels and RPO](https://learn.microsoft.com/azure/cosmos-db/consistency-levels)
