---
title: "Zero-trust networking on AWS for a regulated bank: Verified Access, VPC Lattice, PrivateLink and an inspection VPC"
description: "A zero-trust network design for a bank on AWS: account and VPC layout, workforce access without a VPN through Verified Access, service-to-service calls authorised by VPC Lattice auth policies, PrivateLink to partners, Network Firewall inspection and egress, and the IAM data perimeter that ties it together. Requirements with numbers, Well-Architected mapping, five real scenarios, a cost estimate and four editable draw.io diagrams."
date: 2026-11-21T03:07:00Z
category: Cloud & DevOps
coverLabel: "Trust nothing.\nCheck every\nrequest."
coverCode: "no VPN · no IGW in prod · deny by default"
coverLogos: "aws"
coverImage: /assets/images/covers/zero-trust-networking-aws.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Trust nothing. Check every request.', with the AWS logo."
---
Most bank networks I've seen on AWS were designed like the data centre they replaced. A big flat VPC per environment, a VPN for staff, a firewall at the edge, and an unspoken rule that anything already inside is probably fine. That last rule is the one that fails. A contractor's laptop gets compromised, the attacker lands on the VPN, and from there the core banking database is two hops away because nothing between them asks who's calling.

Zero trust is the opposite assumption: being on the network proves nothing. Every request carries an identity, every hop checks it, and the network itself is cut up so that the places nobody needs to reach aren't reachable at all. On AWS you don't build that with one product. You build it from IAM, a handful of networking services that understand identity, and some old-fashioned routing discipline.

This article is the design I'd put in front of a regulated bank today. It follows one example estate through workforce access, service-to-service calls, partner connectivity and egress, with the requirements written down first so every choice can be traced back to a number. There are four editable `.drawio` diagrams built with the AWS shapes that ship with draw.io, and five scenarios at the end that test the design against things that actually happen.

## The short version

- **Identity on every request, network as the second lock.** IAM and the identity-aware services decide *who* may call; route tables, security groups and the firewall decide *what can even be reached*. You need both. Neither is enough alone.
- **Staff reach internal apps through AWS Verified Access, not a VPN.** Each request is checked against the user's IAM Identity Center groups and the laptop's posture score from a device trust provider. A compromised laptop loses access on its next request, not at the next VPN reconnect.
- **Services call each other through VPC Lattice with IAM auth policies.** Calls are SigV4-signed with the workload's own role. A coarse policy on the service network and a fine one on each service must both allow the call.
- **Partners connect through PrivateLink.** One port, one direction, no peering, no shared routing, no CIDR negotiation.
- **Everything that crosses a trust zone, and everything leaving for the internet, goes through Network Firewall** in an inspection VPC, with Transit Gateway route tables that make the detour impossible to skip.
- **Workload VPCs have no internet gateway.** Egress is an allow-list of named domains. DNS is filtered too, because DNS is how data leaves when everything else is locked.
- **Prove it continuously.** Network Access Analyzer checks every night that no path into the cardholder data environment exists that you didn't design. That report is your segmentation evidence.

## The scenario

The example is a mid-sized digital bank. The numbers are illustrative, but they're the kind of numbers you should write down before drawing anything.

- 2.4 million retail customers, a card programme in PCI DSS scope, and a banking regulator that asks for evidence of network segmentation, privileged access control and third-party connectivity.
- 31 AWS accounts under AWS Organizations, 22 VPCs in the primary Region and a matching set in the DR Region.
- About 60 services on EKS and ECS on Fargate, Aurora PostgreSQL for the ledger and the card token vault.
- 900 employees and 120 contractors who use 25 internal web applications (loan review, back office, fraud case management) and a few TCP targets (databases for on-call DBAs, a handful of SSH hosts that haven't been retired yet).
- 38 third-party APIs the platform calls out to: card network, KYC and sanctions screening, a credit bureau, email and SMS providers.
- Peak east-west traffic around 3.5 Gbps, peak internet egress around 1.2 Gbps.

### Requirements

Write these down with the security, platform and compliance leads in the room. Most arguments later are settled by pointing at this table.

| # | Requirement | Target | Drives |
|---|---|---|---|
| R1 | No workload is reachable from the internet except through the public edge (CloudFront and WAF in front of the customer APIs) | Zero internet gateways in workload VPCs | VPC design, SCPs |
| R2 | Staff and contractor access to internal apps without a network-level VPN | 25 web apps and 6 TCP targets, MFA plus device posture on every request | Verified Access |
| R3 | Access is revoked quickly when a device becomes non-compliant or a user leaves | Next request after the trust provider reports the change; joiner/mover/leaver driven by HR groups | Verified Access, IAM Identity Center |
| R4 | Service-to-service calls are authenticated and authorised by workload identity, deny by default | 100% of calls into the CDE signed and policy-checked | VPC Lattice auth policies |
| R5 | Prod and non-prod can never talk to each other | No route, verified nightly | TGW route tables, Network Access Analyzer |
| R6 | Traffic between trust zones and all internet egress is inspected | Egress limited to 38 named FQDNs; everything else dropped and alerted | Network Firewall, DNS Firewall |
| R7 | Partners connect without network-level trust | No peering or VPN to any partner; one port per integration | PrivateLink |
| R8 | Inspection is not a single point of failure | One firewall endpoint and NAT gateway per AZ; losing an AZ loses only that AZ | Inspection VPC design |
| R9 | Added latency stays small enough that teams don't route around it | Our budget: p99 under 5 ms added per inspected hop, measured, not assumed | Placement, appliance mode |
| R10 | Every allow and deny is logged centrally and is tamper-evident | Flow, firewall, DNS, Verified Access and Lattice logs in Security Lake within 15 minutes | Logging design |
| R11 | Segmentation evidence for PCI DSS and the regulator on demand | Automated report, not a yearly spreadsheet | Network Access Analyzer, Config |

## What zero trust means on AWS, concretely

AWS's own guidance on zero trust makes a point that's easy to skip: it isn't about removing the network controls, it's about not *relying* on them alone. A request should be allowed because the caller's identity, the device or workload it comes from, and the context all check out, and the network should also make the request impossible when it doesn't need to be possible.

In practice that gives you three layers, and this design uses all three:

1. **Identity-aware access points.** Verified Access for humans, VPC Lattice for services, IAM-authenticated AWS APIs through VPC endpoints. Each one evaluates a policy per request.
2. **Network segmentation.** Accounts, VPCs without internet gateways, Transit Gateway route tables that encode which zones can talk, security groups that reference each other instead of CIDRs.
3. **Inspection and detection.** Network Firewall and DNS Firewall where traffic crosses zones or leaves, and logs from every layer flowing into one place.

## The reference architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-zero-trust/aws-zero-trust-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-zero-trust/aws-zero-trust-reference.svg" alt="Zero-trust reference architecture inside one AWS Organization. Employees and contractors, 1,020 people with no VPN, connect to AWS Verified Access in a workforce access account, which uses IAM Identity Center as the user trust provider and CrowdStrike, Jamf or JumpCloud as the device trust provider, with Cedar policies checking group and device score. Verified Access endpoints reach internal ALBs over HTTPS and RDS over TCP in the core banking account. A network account holds a Transit Gateway with prod, non-prod and firewall route tables, an inspection and egress VPC with Network Firewall endpoints per AZ, NAT gateways and an internet gateway, attached in appliance mode, and Route 53 Resolver DNS Firewall associated with every VPC through Firewall Manager. Egress goes through the firewall to 38 allow-listed third-party APIs. A shared services account holds central interface endpoints for STS, KMS, Secrets Manager, ECR and logs with an org-only endpoint policy, Route 53 private hosted zones for them, and the VPC Lattice service network bank-prod shared through RAM. The payments account, in PCI DSS scope, has a CDE VPC with no internet gateway running payments-api and tokenizer on ECS Fargate, Aurora PostgreSQL holding tokens only, a Lattice association and a PrivateLink endpoint to the credit bureau. The core banking account has a core VPC with no internet gateway running ledger and loans on EKS, Aurora for the ledger, and a Lattice association. Non-prod accounts have their own TGW route table with blackhole routes to the prod CIDR and are not associated with the prod service network. A security tooling account holds Security Lake collecting flow, DNS, Verified Access, Lattice and firewall logs, GuardDuty, Security Hub, Network Access Analyzer running nightly scopes, and Firewall Manager." width="1500" height="1000" loading="lazy"></a><figcaption>Accounts as trust zones, and the four ways traffic moves: workforce access, service-to-service, partner, and inspected egress.</figcaption></figure>

### Accounts are the first trust boundary

| Account | What lives there | Why it's separate |
|---|---|---|
| Workforce access | Verified Access instance, trust providers, its logs | The team that owns staff access doesn't need rights in any workload account, and workload teams can't change who gets in |
| Network | Transit Gateway, inspection and egress VPC, Network Firewall, DNS Firewall rule groups | One place for routing and egress policy. Workload teams can't add a route to the internet |
| Shared services | Central interface endpoints, private hosted zones, the Lattice service network | Shared plumbing with one owner, shared out with AWS RAM |
| Payments (PCI) | The cardholder data environment: payments API, tokenizer, token vault | PCI DSS scope is one account and one VPC, not the whole estate |
| Core banking | Ledger, loans, customer services | The bank's crown jewels, with a different change process to the card platform |
| Non-prod | Dev and staging | Synthetic data only. No route to prod, not associated with the prod service network |
| Security tooling | Security Lake, GuardDuty, Security Hub, Network Access Analyzer, Firewall Manager admin | Investigators see everything without having access to change anything |

Two SCPs carry a lot of the weight here. One denies `ec2:CreateInternetGateway`, `ec2:AttachInternetGateway` and `ec2:CreateEgressOnlyInternetGateway` everywhere except the network account (and the account that runs the public edge). The other denies `ec2:CreateVpcPeeringConnection` and creating or accepting Transit Gateway attachments outside the network account. Without these, any team with admin rights can quietly create the path you spent months closing. If an SCP or permission boundary has ever surprised you, the [explicit deny article](/blog/cloud-iam-explicit-deny/) covers how the evaluation order works.

### VPC and IP design

- **Plan addresses with VPC IPAM.** Prod gets `10.32.0.0/11`, non-prod `10.64.0.0/11`, and each account draws from its pool. Non-overlapping ranges are what let a single blackhole route cut off all of prod (Reliability pillar REL02: enforce non-overlapping private ranges and leave room to grow).
- **No internet gateway, no public subnets** in any workload VPC. The subnet route table's default route points at the Transit Gateway, so the only way out is through inspection.
- **Security groups reference security groups.** The tokenizer's group allows 443 from the Lattice managed prefix list, the ALB's group allows 443 from the Verified Access endpoint's group. CIDR-based rules age badly; references don't.
- **Network ACLs stay coarse.** Use them for a few explicit denies at subnet level (block the non-prod ranges, for example) as a second lock, not as the main policy.
- **Interface endpoints are central, except in the CDE.** Most VPCs use the shared endpoints through private hosted zones. The CDE keeps its own small set so its PCI scope doesn't depend on another account's endpoint configuration.

## Workforce access with Verified Access

<figure class="diagram wide"><a href="/assets/diagrams/aws-zero-trust/aws-zero-trust-workforce-access.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-zero-trust/aws-zero-trust-workforce-access.svg" alt="Workforce access with AWS Verified Access. A loan officer on a managed laptop with the CrowdStrike agent (step 1) reaches the Verified Access instance in the workforce access account. The instance (step 4) has two trust providers attached (steps 2 and 3): IAM Identity Center for OIDC sign-in with passkey MFA and groups from the HR feed, and CrowdStrike Zero Trust Assessment as the device trust provider with a score from 0 to 100. The back-office group policy permits a request when the user is in the loan officers group and the device score is at least 70; its endpoint is loans.internal.bank in front of an internal ALB over HTTPS. The database-admin group policy requires the DBA on-call group and a device score of at least 80; its endpoint is ledger-db, an Aurora cluster on TCP 5432, reached by a DBA using the Connectivity Client. A laptop with the agent disabled has its score drop to 22 and gets a 403, which is logged. Each request is evaluated again, so a posture change mid-session ends access on the next request. In the core banking account the internal ALB (step 5) only accepts traffic from the Verified Access endpoint security group and forwards to the loans back-office pods on EKS, which read the x-amzn-ava-user-context header; Aurora uses IAM database authentication. The core VPC has no internet gateway and no public subnets. Access logs in OCSF format, with user, groups, device score, decision and endpoint, go to Security Lake (step 6)." width="1500" height="840" loading="lazy"></a><figcaption>Every request is checked against who the user is and what state their laptop is in. The VPN is gone.</figcaption></figure>

1. The loan officer opens `https://loans.internal.bank`. That name is a CNAME to the Verified Access endpoint's domain, so there's no VPN client and no route into the VPC.
2. Verified Access sends the user to **IAM Identity Center** (or another OIDC provider such as Okta or Entra ID) to sign in with MFA. Group membership comes from the HR system through SCIM, so a leaver loses their groups when HR closes the record.
3. The **device trust provider** reports the laptop's posture. Verified Access supports CrowdStrike, Jamf and JumpCloud as device trust providers. Here it's the CrowdStrike Zero Trust Assessment score.
4. The **group policy**, written in Cedar, is evaluated for that request. Policies sit on the Verified Access group, so all back-office apps share one policy, and an endpoint can add a stricter one of its own.
5. If the policy allows, Verified Access forwards the request to the **internal ALB**, whose security group only accepts traffic from the Verified Access endpoint. The application gets a signed `x-amzn-ava-user-context` header with the user's claims, so it can do its own authorisation without re-authenticating.
6. Every decision, allow or deny, is logged in OCSF format, including the user, groups and device score. Those logs go to Security Lake.

The policy itself is short:

```cedar
permit(principal, action, resource)
when {
  context.idc.groups has "<loan-officers-group-id>"
  && context.crwd.assessment.overall >= 70
};
```

`idc` and `crwd` are the policy reference names you choose when you attach each trust provider. Group IDs, not names, are what Identity Center passes, so keep a mapping in your Terraform rather than hard-coding IDs in five places.

**TCP targets.** Verified Access also supports non-HTTP endpoints (SSH, RDP, database ports) through the AWS Verified Access Connectivity Client on the user's laptop. That's what lets the DBA on call reach the ledger database without a bastion host. Pair it with IAM database authentication so the database login is a short-lived token rather than a shared password.

**What it doesn't replace.** Verified Access is for people reaching private applications. It's not a path for services, and it's not a replacement for strong authorisation inside the app. The header it passes is a starting point for the app's own checks, not a substitute for them.

## Service-to-service with VPC Lattice and PrivateLink

<figure class="diagram wide"><a href="/assets/diagrams/aws-zero-trust/aws-zero-trust-service-to-service.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-zero-trust/aws-zero-trust-service-to-service.svg" alt="Service-to-service security. Top half, VPC Lattice: in the core banking account's core VPC, the loans service, an EKS pod with role loans-svc through Pod Identity, sends SigV4-signed HTTPS with signing name vpc-lattice-svcs through the VPC association, whose security group allows 443 from the app node security group. The campaigns service with role campaigns-svc is refused with 403 AccessDeniedException because no policy allows it. The service network bank-prod in the shared services account uses auth type AWS_IAM and is shared with the organization through RAM; its coarse auth policy allows vpc-lattice-svcs:Invoke for any principal whose aws:PrincipalOrgID is the bank's organization. On every request Lattice resolves tokenizer.bank.internal to a link-local address, checks the SigV4 signature and the network policy, checks the service policy, forwards to a healthy target and writes an access log with caller ARN, path and status, with no Transit Gateway hop, route tables or CIDR overlap issue. In the payments account's CDE VPC, the Lattice service tokenizer on port 443 with a custom domain forwards to tokenizer tasks on ECS Fargate, whose security group allows the Lattice prefix list, which read the Aurora token vault. The service auth policy, owned by payments, allows only the loans-svc role to invoke the tokenizer service with method POST on paths starting /v1/tokens. Bottom half, PrivateLink: payments-api in the CDE VPC uses an interface endpoint to the credit bureau's service, whose security group allows 443 from payments-api only, and interface endpoints for Secrets Manager, KMS, STS, ECR and CloudWatch Logs. The Secrets Manager endpoint policy allows GetSecretValue only when both aws:PrincipalOrgID and aws:ResourceOrgID are the bank's organization. The interface endpoint connects over AWS PrivateLink, TCP 443, one direction only, to a Network Load Balancer endpoint service with acceptance required in the credit bureau's AWS account, in front of its credit check API. Only the bank's account is an allowed principal, there is no peering or route table change, and the bureau cannot open a connection back into the CDE." width="1500" height="880" loading="lazy"></a><figcaption>Inside the bank, calls are authorised by the caller's IAM role. To the partner, PrivateLink exposes one port and nothing else.</figcaption></figure>

### VPC Lattice: two policies, both must allow

A VPC Lattice **service network** is a logical boundary that VPCs and services join. Here the network team owns `bank-prod` in the shared services account and shares it with the organisation through AWS RAM. The core, payments and shared VPCs are associated with it. Non-prod VPCs are not, so a staging pod can't even resolve a prod service.

With auth type `AWS_IAM`, Lattice evaluates two auth policies on every request:

- The **service network policy** is coarse and owned by the network or security team: only principals from our organisation, maybe only from associated VPCs.
- The **service policy** is fine-grained and owned by the team that runs the service: which roles, which methods, which paths.

Both have to allow it. That split works well organisationally. The payments team decides who may call the tokenizer, and nobody else can loosen it, while the platform team can tighten the whole network at once.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<core-account>:role/loans-svc" },
    "Action": "vpc-lattice-svcs:Invoke",
    "Resource": "<tokenizer-service-arn>/*",
    "Condition": {
      "StringEquals": { "vpc-lattice-svcs:RequestMethod": "POST" },
      "StringLike":   { "vpc-lattice-svcs:RequestPath": "/v1/tokens*" }
    }
  }]
}
```

Clients sign requests with SigV4 using the signing name `vpc-lattice-svcs`. On EKS the pod gets its role from EKS Pod Identity; on ECS from the task role. Most AWS SDKs can sign arbitrary HTTP requests, and there are sidecar and proxy patterns if you'd rather not touch application code. Unsigned requests get a 403 when the policy requires an authenticated principal.

Things to know before you commit:

- **Lattice traffic doesn't cross your Transit Gateway.** The client resolves the service to a link-local address and Lattice carries the request to the target VPC. That's the point: no route tables, no CIDR overlap problem. It also means your inspection VPC never sees it. In this design that's accepted on purpose for HTTP calls into the CDE, because every call is authenticated, authorised per path, and logged with the caller's role ARN. Write that down in your segmentation evidence so an assessor sees it was a decision.
- **Auth policies need Lattice to see the request.** They work on HTTP, HTTPS and gRPC listeners. For TLS passthrough listeners and for TCP resources reached through Lattice resource configurations, your controls are security groups, the service network association and the target's own authentication.
- **Targets allow the Lattice prefix list.** The target security group allows traffic from the `com.amazonaws.<region>.vpc-lattice` managed prefix list, not from client CIDRs. Without that rule, health checks and requests fail in a way that looks like an application problem.
- **Access logs are your audit trail.** Send them to Security Lake or CloudWatch Logs. Denied calls appear with the caller's role, which is exactly what you want when a new service forgets to ask for access.

### PrivateLink to partners

For the credit bureau, the bank consumes the bureau's **endpoint service** through an interface endpoint in the CDE VPC. The bureau puts a Network Load Balancer behind the service, requires acceptance, and lists only the bank's account as an allowed principal. The bank's endpoint security group allows 443 from `payments-api` only.

That gives you what a VPN or peering connection can't: one port, one direction, and no routing between the networks. The bureau can't initiate a connection into the CDE, overlapping CIDRs don't matter, and removing the integration is deleting one endpoint. When the bank exposes its own APIs to partners (open banking aggregators, for example) it does the same thing in reverse: an endpoint service in front of an NLB, with acceptance and an allow-list of partner accounts.

| Need | Use | Why |
|---|---|---|
| Service-to-service HTTP and gRPC inside the org | VPC Lattice | Per-request IAM authorisation, cross-account, no routing |
| Consuming or exposing a single service to another organisation | PrivateLink endpoint service | One port, one direction, partner never joins your network |
| AWS APIs from private subnets | Interface or gateway VPC endpoints with endpoint policies | Keeps API calls off the internet and inside the data perimeter |
| Bulk east-west traffic between zones, non-HTTP protocols, on-premises | Transit Gateway with inspection | Network-level reachability with the firewall in the path |

### Endpoint policies and the data perimeter

The VPC endpoints for AWS services have their own policies, and they're one of the cheapest controls in the whole design. The Secrets Manager endpoint in the diagram only allows calls when both `aws:PrincipalOrgID` and `aws:ResourceOrgID` are the bank's organisation. A stolen task role can't use it to push secrets into an attacker's account, and credentials from outside the bank are refused at the endpoint.

AWS calls this pattern a data perimeter, and it has three parts that back each other up:

| Perimeter | Question it answers | Where it's enforced | Condition keys |
|---|---|---|---|
| Identity | Only our principals can touch our resources | Resource control policies, resource policies | `aws:PrincipalOrgID`, `aws:PrincipalIsAWSService` |
| Resource | Our principals can only touch our resources | SCPs, VPC endpoint policies | `aws:ResourceOrgID` |
| Network | Our credentials only work from our networks | SCPs, resource policies | `aws:SourceVpc`, `aws:SourceVpce`, `aws:SourceIp`, `aws:ViaAWSService` |

The network perimeter is the one that matters most when a key leaks. An SCP that denies calls when `aws:SourceVpc` isn't one of yours (with exceptions for AWS services acting on your behalf) turns a stolen access key into a mostly useless string. Roll it out in alert-only mode through CloudTrail first, because it will find integrations you forgot. And remove long-lived keys from CI completely; [workload identity federation](/blog/workload-identity-federation-ci/) makes that straightforward.

## Inspection and egress

<figure class="diagram wide"><a href="/assets/diagrams/aws-zero-trust/aws-zero-trust-inspection.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-zero-trust/aws-zero-trust-inspection.svg" alt="Inspection VPC detail. Three spoke VPCs, core 10.48.0.0/18 and CDE 10.40.0.0/20 in prod and staging 10.72.0.0/16 in non-prod, each have a TGW attachment and a subnet route table sending 0.0.0.0/0 to the Transit Gateway (step 1). The Transit Gateway has three route tables (step 2): the prod-spokes table, associated with core, CDE and shared, sends 0.0.0.0/0 to the inspection attachment and has no propagations, so spokes never see each other; the non-prod table, associated with staging and dev, has a blackhole route for 10.32.0.0/11, all of prod, and sends 0.0.0.0/0 to the inspection attachment; the firewall table, associated with the inspection attachment, has every spoke CIDR propagated and is the return path. Appliance mode is on for the inspection attachment. The inspection and egress VPC 10.33.16.0/22 spans two Availability Zones, each with a TGW subnet whose route table sends 0.0.0.0/0 to the same-AZ firewall endpoint (step 3), a firewall subnet with the Network Firewall endpoint whose route table sends 0.0.0.0/0 to the NAT gateway and 10.0.0.0/8 to the Transit Gateway (step 4), and a public subnet with a NAT gateway whose route table sends 0.0.0.0/0 to the internet gateway and 10.0.0.0/8 back to the same-AZ firewall endpoint (step 5), then the internet gateway (step 6). The return path goes from the public subnet through the same-AZ firewall endpoint, the TGW and the firewall route table to the spoke, so both directions are inspected. The firewall policy is stateful with strict order and default actions drop established and alert established, with rule groups: deny prod to non-prod by CIDR; allow core to the CDE tokenizer on TCP 443 only from two named subnets; an egress allow-list of 38 FQDNs matched on TLS SNI and HTTP Host; Suricata rules dropping TLS without SNI, non-TLS on 443 and DNS over HTTPS resolvers; and AWS managed threat signature groups in drop mode. Alert and flow logs go to S3 in the log archive account, then Security Lake, and every rule change ships through a pipeline with a test VPC in alert mode first. A second box notes Route 53 Resolver DNS Firewall on every VPC with Advanced rules for DNS tunnelling and DGA domains, appliance mode keeping both directions of a flow in one AZ, and one firewall endpoint and NAT gateway per AZ." width="1500" height="900" loading="lazy"></a><figcaption>Route tables make inspection unavoidable. Numbers follow one packet from the core VPC to a third-party API.</figcaption></figure>

### The routing is the policy

The firewall can only inspect what's routed to it, so the Transit Gateway route tables do most of the enforcing:

1. **Spoke subnets** send everything that isn't local to the Transit Gateway.
2. **The prod-spokes route table** has a single default route to the inspection attachment and *no propagations*. Spokes can't reach each other directly because they don't know each other's routes. Every east-west packet between prod VPCs goes through the firewall.
3. **The non-prod route table** has a blackhole route for all of prod (`10.32.0.0/11`) plus a default route to inspection for internet egress. Non-prod can't reach prod even if a firewall rule is wrong. That's requirement R5 enforced twice.
4. **The firewall route table**, associated only with the inspection attachment, has every spoke's CIDR propagated. It's the path back after inspection.
5. **Inside the inspection VPC**, each AZ's TGW subnet sends traffic to the firewall endpoint *in the same AZ*, the firewall subnet sends internet-bound traffic to that AZ's NAT gateway, and the public subnet sends return traffic for `10.0.0.0/8` back through the same AZ's firewall endpoint.

**Turn on appliance mode for the inspection attachment.** Without it, the Transit Gateway picks an AZ for each direction of a flow independently. The request goes through the firewall in AZ a, the response comes back through AZ b, and the stateful firewall in AZ b drops a packet for a connection it has never seen. It shows up as a fraction of connections failing intermittently, which is the worst kind of failure to debug. Appliance mode keeps both directions of a flow on the same AZ.

If you run the newer native Transit Gateway attachment for Network Firewall where it's available, AWS manages the inspection VPC plumbing for you. The routing logic in steps 2 to 4 still applies. I've shown the explicit inspection VPC because it's what most estates run today and it makes each hop visible.

### The firewall policy

Use a **strict-order** stateful policy so rules evaluate in the order you wrote them, with **drop established** and **alert established** as default actions. That's a default-deny firewall that tells you what it dropped. The rule groups, in order:

| Order | Rule group | Type | What it does |
|---|---|---|---|
| 1 | Prod and non-prod separation | Stateful, 5-tuple | Drops anything between the two pools. Redundant with routing on purpose |
| 2 | Zone-to-zone allows | Stateful, 5-tuple | Core to the CDE on 443 from two named subnets, for the TCP flows that don't go through Lattice |
| 3 | Egress allow-list | Domain list | The 38 partner FQDNs, matched on TLS SNI and HTTP Host header |
| 4 | Protocol hygiene | Suricata | Drop TLS without SNI, non-TLS traffic on 443, and known DNS-over-HTTPS resolvers that would bypass DNS Firewall |
| 5 | Threat signatures | AWS managed | Malware, botnet and emerging threat signatures, in drop mode once tuned |

SNI matching tells you which hostname a client *asked* for, not what's inside the TLS session. For most egress control that's the right trade. If the regulator or your own risk team needs content inspection for specific destinations, Network Firewall supports TLS inspection with a certificate from ACM. Scope it to those destinations. Decrypting everything costs latency and money, and puts a lot of sensitive traffic in front of one more component.

Deploy the policy through **Firewall Manager** so every new VPC and account gets the baseline automatically, and keep rule groups in Terraform. Every change goes through a pipeline that deploys to a test VPC, runs a set of allowed and denied probes, and ships new rules in alert mode for a day before switching to drop.

### DNS is an exfiltration path too

Once egress is locked to 38 domains, DNS is the obvious next way out. Data can be encoded into DNS queries to an attacker's domain, and the resolver will happily forward them. **Route 53 Resolver DNS Firewall** sits on every VPC's resolver:

- AWS managed domain lists for malware and botnet domains, set to block.
- DNS Firewall Advanced rules to detect DNS tunnelling and domain generation algorithm (DGA) patterns.
- An alert-everything rule at the lowest priority, so you can see which domains each VPC actually resolves. After a month, that list is the best input you'll have for tightening the egress allow-list.

Resolver query logs go to Security Lake alongside everything else.

## Detection and evidence

Zero trust produces a lot of decisions. Make them useful:

- **Security Lake** collects VPC flow logs, Route 53 Resolver query logs, Security Hub findings and CloudTrail natively, normalised to OCSF. Network Firewall, Verified Access and Lattice logs go to S3 in the log archive account and are added as custom sources, or go straight to your SIEM. The aim is one query that answers "what did this role or this laptop touch in the last 24 hours".
- **GuardDuty** with runtime monitoring on EKS and ECS, and its DNS-based findings, catches the behaviour that policies miss.
- **Network Access Analyzer** runs a set of scopes every night: no path from any internet gateway to the CDE VPC, no path from non-prod to prod, no path from the CDE to the internet except through the inspection VPC. A finding is a page, not a ticket. That report, archived nightly, is the segmentation evidence PCI DSS and the regulator ask for.
- **Reachability Analyzer** for the opposite question during troubleshooting: why *can't* this reach that.
- **AWS Config** rules for the configuration drift that opens paths: an internet gateway attached, a security group allowing `0.0.0.0/0`, a VPC endpoint with a full-access policy.

## Mapping to the AWS Well-Architected Framework

| Pillar | What the design does | Best practices it addresses |
|---|---|---|
| Security | Network layers by account and VPC, traffic controlled at every layer, inspection where zones meet, policies deployed by Firewall Manager and pipelines; identity on every request | SEC05-BP01 create network layers, SEC05-BP02 control traffic flow within your network layers, SEC05-BP03 implement inspection-based protection, SEC05-BP04 automate network protection; SEC02 and SEC03 for identities and permissions; SEC04 for logging and detection |
| Reliability | Hub-and-spoke through Transit Gateway, non-overlapping IPAM pools, one firewall endpoint and NAT gateway per AZ, appliance mode | REL02 plan your network topology: prefer hub-and-spoke over mesh, non-overlapping private ranges, subnet allocation for growth |
| Operational excellence | Firewall and policy changes as code, tested in a pipeline, shipped in alert mode first; one logging destination | Small, reversible, observable changes |
| Performance efficiency | Lattice for service calls avoids hair-pinning through the firewall; inspection only where zones meet; latency budget measured per hop | PERF04: select and configure networking resources from measured requirements |
| Cost optimisation | Inspection scoped to traffic that crosses zones; gateway endpoints for S3 and DynamoDB; TLS inspection only for named destinations | COST08: plan for data transfer charges |
| Sustainability | Fewer always-on appliances and VPN concentrators; managed services scale with traffic rather than being sized for peak | Use managed services and right-size what's left |

## Five scenarios, and what the design does

### 1. A contractor's laptop is compromised on a Tuesday afternoon

At 14:02 the endpoint agent on a contractor's laptop is disabled by malware. The CrowdStrike score for that device drops from 84 to 22 at 14:05. The contractor's browser is still signed in to the loan review app.

With a VPN, that session would have stayed up until the VPN reconnected, possibly hours, with network-level access to everything the VPN subnet could reach. With Verified Access, the next request after the score changes is evaluated against `context.crwd.assessment.overall >= 70` and refused. The deny lands in the access logs with the user, device and score, a Security Hub finding is raised from the EDR side, and the SOC has the user's last 30 requests in one query. Blast radius: the screens the contractor already had open.

**What made the difference:** per-request evaluation of device posture, and no network path from the laptop to anything.

### 2. A new service tries to read card tokens

The marketing team ships a `campaigns` service in the core VPC. It calls the tokenizer to "enrich" customer records, which it was never supposed to do. Every call gets a `403 AccessDeniedException` because the tokenizer's service policy only allows `loans-svc`. The Lattice access logs show 1,400 denied calls in the first hour, all from `role/campaigns-svc`.

Nothing broke, nothing leaked, and the conversation the next morning was about requirements, not an incident report. If the same service had been given network access to the tokenizer the old way, by opening a security group to the core VPC CIDR, it would have worked, and nobody would have known until an audit.

**What made the difference:** authorisation by workload identity per service, owned by the team that owns the data.

### 3. Data leaving over DNS

A compromised build dependency in a staging service starts encoding environment variables into DNS lookups for subdomains of a freshly registered domain: about 300 queries a minute, each label 50-odd characters of base32. HTTPS egress to the domain is already blocked, because it isn't on the allow-list, so this is the path left.

DNS Firewall Advanced flags the pattern as tunnelling and blocks it. GuardDuty raises a DNS exfiltration finding for the same workload. The resolver query logs show which pod started it and when. Total data out before the block: a few kilobytes, mostly the first queries before the pattern was recognised. And because it was staging, the environment variables were synthetic.

**What made the difference:** treating DNS as an egress path, and keeping real data out of non-prod.

### 4. One in three payment calls fails after a network change

After the network team rebuilt the inspection attachment in Terraform, about a third of calls from the core VPC to the card network API started timing out. Retries mostly succeeded, so error rates looked like flaky upstream behaviour. It took two days to notice that failures correlated with source AZ.

The rebuilt attachment didn't have appliance mode enabled. Requests left through the firewall endpoint in one AZ and some responses came back through another, where the stateful engine had no record of the connection and dropped them. Enabling appliance mode fixed it in minutes.

**What made the difference, next time:** a Config rule that checks appliance mode on inspection attachments, a synthetic test that exercises each AZ separately, and firewall alert logs on a dashboard, where the drops for "established" traffic were visible all along.

### 5. The assessor asks for segmentation evidence

The PCI DSS assessment includes testing that segmentation controls actually isolate the CDE from out-of-scope systems, and the regulator wants the same evidence for prod and non-prod. In the old estate this was two weeks of screenshots and a penetration test.

Here, the team exports the last 90 nightly Network Access Analyzer reports, each showing zero findings for the "no path into the CDE" and "no path from non-prod to prod" scopes, plus the one night in August when a finding appeared: an engineer had created a VPC peering connection from a sandbox. The SCP that should have blocked it had an exception for that OU. The finding paged the on-call engineer at 02:10, the peering was removed by 02:40, and the SCP exception was closed the same week. The assessor's questions were about the process, which is what you want them asking about.

**What made the difference:** continuous evidence, and the honesty of showing the one failure and how fast it was caught.

## What it costs

Rough monthly costs for this estate in one Region, using approximate us-east-1 list prices. Prices change and vary by Region, so treat this as the shape of the bill, not a quote, and check each service's pricing page before you build.

| Item | Assumption | Approx. per month |
|---|---|---|
| Network Firewall endpoints | 3 AZs × 730 h at about $0.395 | ~$865 |
| Network Firewall data processing | 40 TB (18 TB egress + 22 TB inspected east-west) at about $0.065/GB | ~$2,600 |
| NAT gateways | 3 AZs plus 18 TB processed (charges can be partly offset when used with Network Firewall; see the pricing page) | up to ~$910 |
| Transit Gateway | 22 attachments plus about 80 TB processed (inspected traffic crosses it twice) | ~$2,400 |
| VPC Lattice | 60 services, 30 TB, 3 billion requests | ~$2,150 |
| Verified Access | 25 applications, billed per application-hour plus data | ~$5,000 |
| PrivateLink and VPC endpoints | ~19 interface endpoints across 3 AZs, partner endpoint, 8 TB | ~$500 |
| Route 53 Resolver DNS Firewall | about 1.5 billion queries a month | ~$900 |
| **Total** | | **about $15,000** |

The levers that move it:

- **Don't inspect what's already authenticated per request.** Lattice traffic doesn't pay firewall or Transit Gateway processing. Moving HTTP service calls from TGW to Lattice is usually cheaper as well as safer.
- **Gateway endpoints for S3 and DynamoDB are free** and keep that traffic off NAT and the firewall entirely.
- **Group Verified Access endpoints by sensitivity**, not one per tiny app, and retire apps that nobody opens.
- Put the total against what it replaces: VPN concentrators and licences, firewall appliance licences and their HA pairs, and the people-hours spent on yearly segmentation evidence.

## How to roll it out without a big bang

1. **Weeks 1-4, see before you block.** IPAM, flow logs everywhere, DNS Firewall in alert mode, Network Firewall with the allow-list in alert mode. You'll learn your real egress list.
2. **Weeks 5-8, close the doors.** SCPs for internet gateways and peering, non-prod blackhole routes, Network Access Analyzer scopes running nightly.
3. **Weeks 9-14, move people.** Verified Access for the 25 web apps, one group at a time, with the VPN still up. Turn the VPN off for each group when its usage drops to zero for two weeks.
4. **Weeks 15-24, move services.** Lattice for calls into the CDE first, because that's where the evidence matters most, then the rest. Switch egress rules to drop.
5. **Ongoing.** Data perimeter conditions in SCPs and endpoint policies, alert mode first. Quarterly game days for scenarios 1, 3 and 4.

## Checklist

- No internet gateways or public subnets in workload VPCs, enforced by SCP
- IPAM pools with non-overlapping prod and non-prod ranges
- Transit Gateway route tables: prod spokes with no propagations, non-prod blackhole to prod, firewall table for the return path
- Appliance mode on the inspection attachment, checked by a Config rule
- Network Firewall per AZ, strict order, default drop, egress by domain allow-list, deployed by Firewall Manager
- DNS Firewall on every VPC, with tunnelling and DGA detection
- Verified Access for every internal web app and TCP target, user and device trust providers, no VPN
- VPC Lattice service network with AWS_IAM auth, coarse network policy and fine service policies
- PrivateLink for every partner integration, acceptance required, one port
- VPC endpoint policies and SCPs using `aws:PrincipalOrgID`, `aws:ResourceOrgID` and `aws:SourceVpc`
- All logs in Security Lake; Network Access Analyzer reports archived nightly as segmentation evidence
- Everything in Terraform, every policy change tested and shipped in alert mode first

If you're building the Terraform for this, the [Terraform on AWS enterprise guide](/blog/terraform-aws-enterprise-guide/) covers the state layout and per-account CI roles. For the Kubernetes side of the same idea, pod-to-pod traffic inside a cluster, see [default-deny network policies](/blog/kubernetes-network-policies-default-deny/).

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the accounts, CIDRs and services to match your estate.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-zero-trust/aws-zero-trust-networking.drawio)
- [Zero-trust reference architecture](/assets/diagrams/aws-zero-trust/aws-zero-trust-reference.drawio)
- [Workforce access with Verified Access](/assets/diagrams/aws-zero-trust/aws-zero-trust-workforce-access.drawio)
- [Service-to-service with VPC Lattice and PrivateLink](/assets/diagrams/aws-zero-trust/aws-zero-trust-service-to-service.drawio)
- [Inspection and egress with Network Firewall](/assets/diagrams/aws-zero-trust/aws-zero-trust-inspection.drawio)

Account names, CIDRs, user counts and prices are examples. Check service availability, quotas and prices in your own Regions before you build.

## References

- [Zero Trust on AWS](https://aws.amazon.com/security/zero-trust/)
- [AWS Well-Architected Framework: Security pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [AWS Well-Architected Framework: Reliability pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
- [What is AWS Verified Access?](https://docs.aws.amazon.com/verified-access/latest/ug/what-is-verified-access.html)
- [Verified Access policies](https://docs.aws.amazon.com/verified-access/latest/ug/auth-policies.html)
- [What is Amazon VPC Lattice?](https://docs.aws.amazon.com/vpc-lattice/latest/ug/what-is-vpc-lattice.html)
- [VPC Lattice auth policies](https://docs.aws.amazon.com/vpc-lattice/latest/ug/auth-policies.html)
- [What is AWS PrivateLink?](https://docs.aws.amazon.com/vpc/latest/privatelink/what-is-privatelink.html)
- [Control access to VPC endpoints using endpoint policies](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-access.html)
- [What is AWS Network Firewall?](https://docs.aws.amazon.com/network-firewall/latest/developerguide/what-is-aws-network-firewall.html)
- [Transit Gateway: appliance in a shared services VPC](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-appliance-scenario.html)
- [Building a scalable and secure multi-VPC AWS network infrastructure (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/building-scalable-secure-multi-vpc-network-infrastructure/welcome.html)
- [Route 53 Resolver DNS Firewall](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-dns-firewall.html)
- [Building a data perimeter on AWS (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/building-a-data-perimeter-on-aws/building-a-data-perimeter-on-aws.html)
- [Amazon VPC IP Address Manager](https://docs.aws.amazon.com/vpc/latest/ipam/what-it-is-ipam.html)
- [Network Access Analyzer](https://docs.aws.amazon.com/vpc/latest/network-access-analyzer/what-is-network-access-analyzer.html)
- [Amazon Security Lake](https://docs.aws.amazon.com/security-lake/latest/userguide/what-is-security-lake.html)
