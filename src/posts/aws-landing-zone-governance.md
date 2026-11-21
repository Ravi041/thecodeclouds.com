---
title: "AWS multi-account landing zone and governance: Organizations, Control Tower, SCPs and Identity Center at enterprise scale"
description: "How to run 180 AWS accounts without losing control: OU design, account vending with Control Tower Account Factory for Terraform, SCPs and RCPs rolled out like code, IAM Identity Center with temporary elevated access, centralized logging and detection, mapped to the AWS Well-Architected pillars. Six real onboarding and incident scenarios and five editable draw.io diagrams."
date: 2026-11-21T03:06:00Z
category: Cloud & DevOps
coverLabel: "One org.\n180 accounts.\nZero IAM users."
coverCode: "SCP · RCP · Identity Center · AFT"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-landing-zone-governance.jpg
coverImageAlt: "Cloud & DevOps cover reading 'One org. 180 accounts. Zero IAM users.', with the AWS logo."
---
Every AWS estate I've been asked to "tidy up" looked the same from the inside. One account that started as the company's only account and still runs production. A second organization someone created for a proof of concept and forgot. Forty IAM users, a third of them for people who've left. An SCP called `DenyStuff` that nobody dares to detach. And a spreadsheet, maintained by one person, that says which account belongs to which team.

None of that is a failure of AWS features. Organizations, Control Tower, service control policies and IAM Identity Center have been around for years. What's usually missing is the design around them: which OUs exist and why, how an account gets created, how a guardrail gets changed without breaking 19 teams, and who can get write access to production at 3 a.m.

This article is that design, written for a company that already has, or will soon have, more than a hundred accounts. The running example is a retail and payments group with 14 product teams, 180 accounts across two regions, a PCI DSS workload and an acquisition in progress. It's the governance layer only. If you want the account layout in the context of a single online shop, the e-commerce series on this blog touches it from the workload side; here we go a level deeper into how the organization itself is run.

There are five diagrams, each an editable `.drawio` file built with the AWS shapes that ship with draw.io, plus a PNG. After the design come six scenarios from real enterprise onboarding work, with the numbers that made them interesting.

## The short version

- **Design OUs around policy, not around the org chart.** An OU exists because a set of accounts needs the same guardrails. Teams move, reorganise and get renamed; "production with cardholder data" doesn't.
- **Vend accounts from a pull request.** Control Tower Account Factory for Terraform (AFT) turns "I need three accounts" from a three-week ticket chain into a reviewed PR and about two hours of waiting, with the baseline applied before anyone signs in.
- **Treat SCPs and RCPs like production code.** They're the only controls that apply to everyone in an account, which means a bad one breaks everyone. Validate them in CI, attach them to a Policy Staging OU first and watch `AccessDenied` before promoting.
- **People get in through IAM Identity Center, machines through OIDC, nobody through access keys.** Standing write access to production is zero; operators request it for an hour and someone else approves it.
- **Logs go to an account nobody can change, findings go to an account somebody watches.** Log Archive holds the evidence, Audit holds the security tooling as delegated administrator, and EventBridge routes findings by severity.
- **Use the forgotten OUs.** Sandbox, Policy Staging, Exceptions, Transitional and Suspended are what make the difference between a landing zone that looks good on day one and one that still works in year three.

## Requirements

Before any diagram, these are the requirements the design has to meet. They came from the security, platform, finance and audit teams of the example company, and they're specific enough to test.

### Functional requirements

| # | Requirement | How it's met |
|---|---|---|
| F1 | A team can get a new set of accounts (dev, staging, prod) without filing tickets | AFT account requests in Git, approved by the platform team |
| F2 | Every new account is governed from the moment it exists | Account is created directly in its target OU; OU-level SCPs, RCPs and Control Tower controls apply immediately |
| F3 | Humans use corporate identities with MFA; no IAM users in member accounts | IAM Identity Center with SCIM from the IdP; SCP denies `iam:CreateUser` and `iam:CreateAccessKey` |
| F4 | Write access to production is time-bound and approved by a second person | Temporary elevated access workflow on top of Identity Center |
| F5 | CI/CD deploys without long-lived credentials | GitHub Actions OIDC to per-account deploy roles |
| F6 | Security can see every account without being able to change workloads | Audit account as delegated administrator for GuardDuty, Security Hub CSPM, Config, Inspector, Access Analyzer |
| F7 | Acquired companies' accounts can be brought in without breaking them | Transitional OU with minimal guardrails, then staged moves |
| F8 | Accounts can be retired safely | Suspended OU with a deny-all SCP before closure |

### Non-functional requirements

| # | Requirement | Target |
|---|---|---|
| N1 | Time from approved request to a usable account | Under 2 hours, no human steps after merge |
| N2 | CloudTrail coverage | 100% of accounts and regions, from account creation |
| N3 | Log integrity and retention | Tamper-evident, 7 years for audit evidence; 400 days queryable |
| N4 | Critical security findings reach on-call | Under 15 minutes from detection |
| N5 | A guardrail change that breaks workloads is rolled back | Under 15 minutes from first alarm |
| N6 | Allowed regions | `eu-west-1` (primary) and `eu-central-1` (DR), plus global services |
| N7 | Cost attribution | At least 98% of spend mapped to a cost centre through account and tags |
| N8 | Scale | 300 accounts within two years without redesign |
| N9 | Standing admin access to production | Zero people |

Notice that most of these are about speed and evidence rather than about specific services. That's deliberate. A landing zone that's secure but takes three weeks to give a team an account will be bypassed within a quarter, usually by someone with a corporate card.

## Organization and OU design

<figure class="diagram wide"><a href="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-org-structure.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-org-structure.png" alt="Organization structure. A management account at the top holds AWS Organizations, Control Tower, IAM Identity Center and billing, with a note that SCPs and RCPs never apply to it. Below it, three main OUs. Security OU with a Log Archive account (organization CloudTrail, log buckets, a KMS key) and an Audit account that is delegated admin for Security Hub, GuardDuty, the Config aggregator, Inspector, Access Analyzer, Detective and Firewall Manager. Infrastructure OU with a Network account (Transit Gateway, egress firewall, Route 53) and a Shared services account (ECR, AFT pipelines, a backup vault). Workloads OU with SCPs for no IAM users, IMDSv2 and approved regions, an RCP data perimeter and a declarative policy blocking public AMI and EBS snapshot sharing; inside it a Prod OU with payments-prod in PCI DSS scope, orders-prod, catalog-prod and data-prod, and a NonProd OU with staging and dev accounts. A second row shows the OUs people forget: Sandbox with per-engineer accounts and a budget action, Policy Staging with canary accounts, Exceptions with dated, reviewed exceptions, Transitional for acquired accounts, and Suspended with a deny-all SCP. A band at the bottom explains the organization policy types and their limits: up to 5 SCPs and 5 RCPs per target, 5,120 characters per policy, up to 5 OU levels below the root, and no effect on the management account or service-linked roles." width="1500" height="990" loading="lazy"></a><figcaption>Diagram 1. OUs grouped by the guardrails they need, with the policy types attached at each level.</figcaption></figure>

The rule I use for OUs: **an OU exists because a set of accounts needs a different policy**. If two OUs would have identical SCPs, RCPs, Control Tower controls and backup policies, they should be one OU.

That rules out the most common mistake, which is mirroring the org chart: `Retail/`, `Payments/`, `Marketing/`. The org chart changes every eighteen months. When it does, you either move accounts (and risk attaching the wrong policies) or live with OUs named after departments that no longer exist. Put the team name in the account name and in tags. Put the risk level in the OU.

### The top-level OUs

This follows AWS's guidance in [Organizing your AWS environment using multiple accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/organizing-your-aws-environment.html), trimmed to what a typical enterprise actually uses:

- **Security.** Log Archive and Audit, managed by Control Tower. Only the security team has write access, and an SCP stops anyone else changing the tooling inside them.
- **Infrastructure.** Network (Transit Gateway, centralised egress, DNS, IPAM), shared services (ECR, the AFT pipelines, backup vaults) and an Identity account if you delegate Identity Center administration.
- **Workloads**, split into **Prod** and **NonProd**. Prod gets the strictest policies, NonProd gets cost caps. Regulated workloads (PCI DSS here) stay inside Prod as their own accounts, because the account boundary is what shrinks audit scope; they only need their own OU if their guardrails differ.
- **Sandbox.** Personal accounts for experiments, with no network path to anything else.
- **Policy Staging.** A handful of canary accounts that receive every guardrail change first (more on this below).
- **Exceptions.** Accounts that need a policy the rest don't, with an owner and an expiry date on the exception.
- **Transitional.** Where acquired accounts land before they've been brought up to standard.
- **Suspended.** A deny-all SCP. Accounts sit here before they're closed.

### Where each policy type belongs

AWS Organizations has grown several kinds of policy, and they're easy to mix up:

| Policy type | What it controls | Example in this design | Attached at |
|---|---|---|---|
| [SCP](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html) | The maximum permissions of principals *in* your accounts | Deny leaving the org, deny disabling CloudTrail/GuardDuty/Config, deny regions outside the allowed two | Root and OUs |
| [RCP](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_rcps.html) | The maximum permissions on *your resources*, whoever is calling | S3, KMS, SQS and Secrets Manager only usable by principals from this organization | Workloads OU |
| [Declarative policy](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_declarative.html) | A service configuration enforced by the service itself | Block public AMI sharing and public EBS snapshots, require IMDSv2 defaults | Root |
| Tag policy | Allowed tag keys and values | `CostCentre`, `Owner`, `DataClass` | Root |
| Backup policy | AWS Backup plans applied to tagged resources | Daily backups, 35-day retention, copy to the DR region for `DataClass=critical` | Prod OU |
| AI services opt-out policy | Whether AWS AI services may store content for service improvement | Opted out org-wide | Root |

Two things about SCPs and RCPs shape the whole design. First, **neither applies to the management account**, so nothing that needs guarding should run there. Second, the [Organizations quotas](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_reference_limits.html): at most five SCPs and five RCPs attached to any one root, OU or account, each document at most 5,120 characters, and OUs nested at most five levels below the root. A deep, org-chart-shaped hierarchy runs into the five-policy limit fast and pushes people into merging unrelated statements into one giant policy. Two or three levels is plenty.

Here's the baseline SCP attached at the root. It's short on purpose; short policies are easier to review and leave room under the character limit for the region list:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProtectAuditTrailAndDetectors",
      "Effect": "Deny",
      "Action": [
        "organizations:LeaveOrganization",
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:PutEventSelectors",
        "guardduty:DeleteDetector",
        "guardduty:DisassociateFromAdministratorAccount",
        "config:StopConfigurationRecorder",
        "config:DeleteConfigurationRecorder",
        "securityhub:DisableSecurityHub"
      ],
      "Resource": "*",
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalARN": [
            "arn:aws:iam::*:role/AWSControlTowerExecution",
            "arn:aws:iam::*:role/platform-guardrail-admin"
          ]
        }
      }
    }
  ]
}
```

And the data-perimeter RCP on the Workloads OU. RCPs always use `"Principal": "*"`, and the `aws:PrincipalIsAWSService` check stops you from locking out AWS services that act on your behalf, such as CloudTrail writing to a bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyOurOrgCanUseOurData",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["s3:*", "kms:*", "sqs:*", "secretsmanager:*"],
      "Resource": "*",
      "Condition": {
        "StringNotEqualsIfExists": { "aws:PrincipalOrgID": "o-exampleorgid" },
        "BoolIfExists": { "aws:PrincipalIsAWSService": "false" }
      }
    }
  ]
}
```

If a vendor genuinely needs to read a bucket, that account moves to the Exceptions OU with a narrower RCP, rather than everyone getting a weaker one. If you've ever been confused about why an explicit allow didn't work once policies like these are in place, [the explicit deny article](/blog/cloud-iam-explicit-deny/) walks through the evaluation order.

### Control Tower, and what it adds on top of Organizations

You can build all of the above with Organizations alone. [AWS Control Tower](https://docs.aws.amazon.com/controltower/latest/userguide/what-is-control-tower.html) is worth using anyway for three reasons:

1. **It sets up and maintains the shared accounts.** Log Archive and Audit, the organization CloudTrail trail and the Config setup, with a versioned landing zone you upgrade rather than hand-maintain.
2. **It ships a catalogue of controls** in three behaviours: *preventive* (implemented as SCPs or RCPs), *detective* (AWS Config rules) and *proactive* (CloudFormation Hooks that reject a non-compliant resource before it's created). You enable them per OU and Control Tower tracks them. The [control reference](https://docs.aws.amazon.com/controltower/latest/controlreference/introduction.html) lists them all.
3. **It detects drift.** If someone edits a Control Tower-managed SCP or moves an account outside Control Tower, you find out and can repair it.

What it doesn't give you is opinionated account customisation: VPCs, baseline IAM roles, budgets, the stuff every account needs on top of the controls. That's what the vending pipeline is for.

## Account vending: one pull request in, a governed account out

<figure class="diagram wide"><a href="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-account-vending.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-account-vending.png" alt="Account vending with Control Tower Account Factory for Terraform. Step 1: a team lead opens a pull request in the account-requests repository, approved by the platform team through CODEOWNERS. Step 2: in the AFT management account, the account-request pipeline writes the request to the aft-request DynamoDB table. Step 3: a request processor Lambda function puts it on an ordered FIFO queue. Step 4: in the management account, Control Tower Account Factory, a Service Catalog product, starts. Step 5: Organizations creates the account and places it in the target OU, and Identity Center gets the user and assignments; the account inherits the OU's SCPs, RCPs and Control Tower controls the moment it lands. Step 6: a CreateManagedAccount event on EventBridge starts the account provisioning framework in Step Functions. Step 7: a per-account customizations pipeline runs. Step 8: the new orders-prod account gets global customizations (delete default VPCs, S3 Block Public Access, EBS encryption by default, IAM Access Analyzer, alternate contacts, baseline tags, root credentials removed), account customizations from the eks-prod template (Transit Gateway attachment, Route 53 Resolver rules, a Backup plan and a VPC CIDR from IPAM) and a hand-off (a 4,000 dollar monthly budget, alerts to the team channel and Identity Center groups). On the left, the Terraform account request module call. At the bottom, an example timeline: PR opened 09:10, approved and merged 09:25, requests in DynamoDB 09:27, Account Factory starts 09:28, all three accounts in their OUs around 10:40, customizations applied around 11:00, team signs in at 11:05. Before, this took 11 tickets across 4 teams and about 3 weeks." width="1500" height="900" loading="lazy"></a><figcaption>Diagram 2. Account Factory for Terraform: the request is code, the account arrives governed, the team signs in the same morning.</figcaption></figure>

[Account Factory for Terraform (AFT)](https://docs.aws.amazon.com/controltower/latest/userguide/aft-overview.html) is AWS's pipeline for Control Tower account vending. You deploy it once, into its own account in the Infrastructure OU, and it watches four repositories: account requests, global customizations (applied to every account), account customizations (applied by template name), and provisioning customizations (extra steps in the provisioning workflow).

An account request is a Terraform module call:

```hcl
module "orders_prod" {
  source = "./modules/aft-account-request"

  control_tower_parameters = {
    AccountEmail              = "aws+orders-prod@example.com"
    AccountName               = "orders-prod"
    ManagedOrganizationalUnit = "Prod (ou-ab12-cdef3456)"
    SSOUserEmail              = "platform-team@example.com"
    SSOUserFirstName          = "Platform"
    SSOUserLastName           = "Team"
  }

  account_tags = {
    CostCentre = "CC-4410"
    Owner      = "orders-team"
    DataClass  = "confidential"
  }

  change_management_parameters = {
    change_requested_by = "orders-team"
    change_reason       = "New orders service, prod account (CHG-20931)"
  }

  account_customizations_name = "eks-prod"
}
```

Merging that file is the only human step. From there, as the diagram shows, the request lands in DynamoDB, a Lambda function queues it, Control Tower's Account Factory creates the account straight into the Prod OU, and an EventBridge event kicks off the provisioning framework that runs the customizations.

### What goes into the baseline

**Global customizations** (every account, no exceptions):

- Delete the default VPC in every region. Nobody should launch into a VPC that wasn't designed.
- S3 Block Public Access at the account level, and EBS encryption by default with the organization's key.
- IAM Access Analyzer for external and unused access.
- Alternate contacts for security, billing and operations, pointing at team distribution lists rather than a person.
- Root credentials removed, using IAM's [centralized root access management](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user.html) for member accounts.

**Account customizations** (by template): `eks-prod` gets a VPC whose CIDR is allocated from Amazon VPC IPAM so it never overlaps, a Transit Gateway attachment to the prod route table, Route 53 Resolver rules for on-premises DNS, and a Backup plan. `sandbox` gets none of the network pieces and a hard budget.

**Hand-off**: an AWS Budgets budget sized from the request with alerts to the team's channel, and Identity Center group assignments so the team can sign in. AFT's own documentation covers the full set of hooks.

One practical tip: keep the account email as a plus-address or alias on a shared mailbox the platform team controls (`aws+orders-prod@`). Root email addresses outlive the people who created them, and you need to be able to receive mail for an account that's three years old.

### Control Tower + AFT, or something else?

| Option | Good fit | Watch out for |
|---|---|---|
| Control Tower + AFT | Teams already on Terraform; wants account requests as PRs | AFT is a fair amount of infrastructure to own; upgrade it on a schedule |
| Control Tower + Customizations for Control Tower (CfCT) | CloudFormation and StackSets shops | Customisation model is StackSets-centric |
| [Landing Zone Accelerator on AWS](https://aws.amazon.com/solutions/implementations/landing-zone-accelerator-on-aws/) | Regulated industries (public sector, healthcare, finance) wanting a large baseline in config files | Big, opinionated; read what it deploys before you deploy it |
| Organizations only, your own Terraform | Very small estates, or teams with a strong reason to avoid Control Tower | You rebuild drift detection, the control catalogue and the log/audit accounts yourself |

For the example company, which already runs Terraform everywhere ([the Terraform on AWS guide](/blog/terraform-aws-enterprise-guide/) describes that setup), Control Tower with AFT was the obvious choice.

## Identity and access

<figure class="diagram wide"><a href="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-identity-access.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-identity-access.png" alt="Identity and access across 180 accounts. On the left, the corporate identity provider such as Entra ID or Okta with 3,200 people and groups like aws-orders-developers, aws-orders-operators, aws-payments-operators, aws-security-audit, aws-platform-admins and aws-finance-billing, with user attributes team, costCentre and clearance sent as session tags. A note says a disabled leaver is removed on the next SCIM sync but role sessions already issued live until they expire. SCIM provisioning and SAML sign-in connect it to IAM Identity Center, an organization instance administered from a delegated Identity account. A table of permission sets: ReadOnly 8 hours for every workload account, Developer 8 hours for the team's NonProd accounts, ProdOperator 1 hour for the team's prod via elevation, PaymentsOperator 1 hour for payments-prod via elevation, SecurityAudit 4 hours read-only everywhere, PlatformAdmin 1 hour via elevation with two approvers, Billing 4 hours in the management account. ABAC compares the resource team tag with the principal team tag so one Developer set serves 40 teams. Identity Center creates AWSReservedSSO roles in the workload and security accounts. Bottom row: temporary elevated access, where an engineer requests, an on-call lead approves, and a 60-minute assignment is created and later removed, with every step in CloudTrail; machines, where a GitHub Actions job uses an IAM OIDC provider and a deploy role whose trust policy only accepts the prod environment of one repository, and an SCP denies creating IAM users and access keys; and root and break-glass, where member accounts have root credentials removed, root-only tasks run as short sts:AssumeRoot sessions from the management account, and two break-glass IAM users in the management account with hardware MFA page the security on-call within a minute of any console login." width="1500" height="830" loading="lazy"></a><figcaption>Diagram 3. People through Identity Center, machines through OIDC, root and break-glass locked away and alarmed.</figcaption></figure>

### People: IAM Identity Center

[IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html) connects to the corporate IdP with SAML for sign-in and SCIM for provisioning users and groups. From then on, access is managed in three places only:

- **Groups in the IdP.** HR and managers change membership; nobody in AWS does.
- **Permission sets**, defined in Terraform. Each is an IAM policy plus a session duration (1 to 12 hours).
- **Assignments**: group × permission set × account, also in Terraform.

Keep the number of permission sets small. The example company runs seven. The trick that makes that possible is [attribute-based access control](https://docs.aws.amazon.com/singlesignon/latest/userguide/abac.html): the IdP passes a `team` attribute as a session tag, and the Developer permission set allows actions only on resources tagged with the same team:

```json
{
  "Effect": "Allow",
  "Action": ["ecs:UpdateService", "lambda:UpdateFunctionCode", "ssm:StartSession"],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "aws:ResourceTag/team": "${aws:PrincipalTag/team}" }
  }
}
```

One Developer set then serves 40 teams instead of needing 40 nearly identical sets. It only works if the tag policy and the vending pipeline make sure resources actually carry the `team` tag, which is why tagging is in the baseline and not left to good intentions.

You can run Identity Center administration from a delegated member account rather than the management account. Do it: it means the people who manage access don't need to sign in to the one account no SCP protects.

### Production writes: temporary elevated access

Nobody in the example company has standing write access to production. Operators have ReadOnly in prod all day, and request ProdOperator when they need it: account, permission set, duration (60 minutes by default), and an incident or change ID. Someone else approves. A Step Functions workflow creates the account assignment and deletes it when the time is up. AWS publishes an open-source reference implementation of this pattern, [TEAM (temporary elevated access management)](https://aws-samples.github.io/iam-identity-center-team/); privileged identity management in your IdP works too. What matters is that the request, the approval and every API call made with the elevated role end up in CloudTrail in the Log Archive account.

### Machines: OIDC, never access keys

CI pipelines assume a deploy role in each account through OIDC federation. The trust policy pins the exact repository and environment:

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:acme/orders:environment:prod"
  }
}
```

Credentials last an hour and are never stored. The SCP that denies `iam:CreateUser` and `iam:CreateAccessKey` in the Workloads OU makes the old way impossible rather than merely discouraged. The [CI federation article](/blog/workload-identity-federation-ci/) has the full setup.

### Root and break-glass

With centralized root access management, member accounts have no root password or access keys at all. The handful of tasks that genuinely need root, such as unlocking an S3 bucket whose policy denies everyone, run as a short `sts:AssumeRoot` session started from the management account (or a delegated account), and are logged like anything else.

Break-glass is for the day Identity Center or the IdP is down. Two IAM users in the management account, each with a hardware MFA key kept in a different safe, with a permission set of exactly what's needed to restore access. An EventBridge rule on their `ConsoleLogin` pages the security on-call within a minute. Test it every quarter: an untested break-glass procedure is a story you tell auditors, not a control.

## Central logging and detection

<figure class="diagram wide"><a href="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-logging-detection.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-logging-detection.png" alt="Central logging and detection. On the left, every member account (orders-prod, payments-prod, catalog-dev) has the organization trail, a Config recorder, VPC flow and DNS logs, and a GuardDuty member, turned on by Control Tower and AFT at vending time and protected by SCP. Logs flow to the Log Archive account: the Control Tower managed organization log bucket for CloudTrail and Config, replicated to an evidence bucket with S3 Object Lock in compliance mode for 7 years, a log KMS key whose policy allows decrypt only for audit roles, and buckets for flow, DNS, WAF and ALB logs by account and region. Notes: CloudTrail log file integrity validation is on, lifecycle moves logs from Standard to Glacier Instant Retrieval to Deep Archive, the bucket policy denies DeleteObject and lifecycle changes to everyone but one break-glass role, and logs are queried in place with Athena. Findings from every account and region go to the Audit account, which is delegated admin for Security Hub CSPM with central configuration and the FSBP and CIS standards, GuardDuty with auto-enable, the Config aggregator with conformance packs, Inspector, Detective and Access Analyzer. All findings flow to an EventBridge bus: CRITICAL and HIGH page on-call through SNS, known patterns are auto-remediated by Lambda, MEDIUM goes as a ticket to the owning team with a 14-day SLA and LOW to a weekly review. A band at the bottom describes four kinds of control: preventive (SCPs, RCPs and declarative policies), proactive (Control Tower proactive controls using CloudFormation Hooks), detective (Config rules, Security Hub controls, GuardDuty) and responsive (EventBridge with Lambda or SSM Automation, only for fixes safe to automate)." width="1500" height="870" loading="lazy"></a><figcaption>Diagram 4. Evidence in Log Archive, findings in Audit, and a routing rule for every severity.</figcaption></figure>

### Evidence: the Log Archive account

Control Tower creates an [organization trail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/creating-trail-organization.html) that logs every account and region to a bucket in Log Archive. Member accounts can see the trail but can't change or stop it. On top of what Control Tower sets up, regulated teams usually add:

- **An evidence bucket with S3 Object Lock in compliance mode**, fed by replication from the Control Tower log bucket. In compliance mode, nobody, including the root user of that account, can delete or shorten retention on a locked object until it expires. That's the answer to "prove nobody deleted logs."
- **CloudTrail log file integrity validation**, so you can show that a log file wasn't modified after delivery.
- **A KMS key for logs** whose key policy lets only audit roles decrypt.
- **A lifecycle** that keeps the last 90 days in S3 Standard for incident response, then Glacier Instant Retrieval (still queryable with Athena) up to the 400-day requirement, then Deep Archive until the seven years are up.

Query logs where they are, with Athena. The moment teams start copying logs into their own accounts "for analysis," you've lost the single source of evidence.

### Findings: the Audit account

The Audit account is [delegated administrator](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_integrate_services_list.html) for every security service that supports it. That lets the security team see and configure everything centrally without needing access to workload accounts, and keeps the management account out of daily use.

- **Security Hub CSPM** with [central configuration](https://docs.aws.amazon.com/securityhub/latest/userguide/central-configuration-intro.html): one configuration policy enables the AWS Foundational Security Best Practices and CIS standards for every account and region, including accounts that don't exist yet.
- **GuardDuty** with auto-enable for new accounts, including the protection plans you pay for (EKS, RDS, S3, Malware Protection, Runtime Monitoring where relevant).
- **AWS Config aggregator** and organization conformance packs for the detective rules Security Hub doesn't cover.
- **Inspector, Detective and IAM Access Analyzer**, all org-wide.

Findings land on an EventBridge bus in the Audit account, and the routing is written down: CRITICAL and HIGH page on-call, MEDIUM opens a ticket against the owning team (found through the account's `CostCentre` and `Owner` tags), LOW goes into a weekly review. Auto-remediation is reserved for fixes that are always safe, such as turning S3 Block Public Access back on.

### Four kinds of control

It helps to name the control types, because the right one depends on whether a violation is *ever* acceptable:

- **Preventive** (SCPs, RCPs, declarative policies): the call fails. Use for things that are never acceptable, like stopping the org trail.
- **Proactive** (Control Tower proactive controls, CloudFormation Hooks): the resource is rejected before it's created. Good for IaC-heavy teams.
- **Detective** (Config rules, Security Hub controls, GuardDuty): something exists and is reported. Use for things that are sometimes acceptable, and track each exception with an expiry date.
- **Responsive** (EventBridge, Lambda, SSM Automation): an automatic fix. Use sparingly.

## Guardrails as code

<figure class="diagram wide"><a href="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-guardrail-rollout.png" title="Open the full-size diagram"><img src="/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-guardrail-rollout.png" alt="Guardrail rollout pipeline in six stages. 1, policy repo: a pull request changes one JSON policy and its Terraform attachment. 2, CI checks: IAM Access Analyzer validate-policy and custom policy checks, and a size check under 5,120 characters. 3, Policy Staging OU: the policy is attached to six canary accounts that run real pipelines and smoke tests. 4, a 7-day soak counting AccessDenied events that name a service control policy or resource control policy. 5, NonProd OU, promoted by merge with a 48-hour watch. 6, Prod OU, in a change window with rollback rehearsed. A dashed rollback path from Prod back to the repo: git revert and the pipeline detaches the policy, targeting under 15 minutes from first alarm. Below, an Athena query over the organization trail that counts AccessDenied events whose error message mentions a service control policy or resource control policy in the last day, grouped by account, event source and event name. Beside it, a real failure the staging OU would have caught: a region-deny SCP allowing only eu-west-1 and eu-central-1 went straight to the Workloads OU at 10:00; at 10:04 CloudFront deployments failed because the ACM certificate for a CloudFront distribution must be requested in us-east-1; by 10:20 there were 47 failed pipeline runs across 19 accounts; the policy was detached by hand at 10:31; a fixed version exempting ACM in us-east-1 for the pipeline role went through staging at 11:30." width="1500" height="650" loading="lazy"></a><figcaption>Diagram 5. SCPs and RCPs ship through canary accounts first, with a query that tells you what they're breaking.</figcaption></figure>

SCPs are the most powerful and the most dangerous thing in the landing zone, because they apply to every principal in an account, including the deploy roles. A permission boundary mistake breaks one role. An SCP mistake breaks every team under that OU at once.

So the example company treats them like production code:

1. **One policy per file, in Git**, with the attachment in Terraform next to it.
2. **CI checks**: IAM Access Analyzer `validate-policy` for syntax and warnings, its custom policy checks to flag changes that grant new access, and a simple script that fails the build above 5,000 characters to leave headroom.
3. **Policy Staging OU first.** Six canary accounts that run the same pipelines as real teams, including a daily CloudFront deployment, an EKS rollout and a Lambda deploy in both regions.
4. **A seven-day soak**, watching for `AccessDenied` events caused by organization policies. CloudTrail's error message says when a deny came from a service control policy or a resource control policy, so a query over the org trail finds them.
5. **NonProd OU, then Prod OU**, each promotion a merge, with a 48-hour watch in between.
6. **Rollback is `git revert`**, and it's rehearsed. The target is under 15 minutes from first alarm to policy detached.

For region restrictions, prefer Control Tower's region deny setting over a hand-written SCP. It maintains the list of global services that must be exempt (IAM, Organizations, Route 53, CloudFront, Support and others), which is exactly the list people get wrong by hand.

## Real-world scenarios

These are composites of enterprise onboarding work I've been involved in. Names and some numbers are changed; the shape of each problem isn't.

### 1. A new product team, from nothing to first deploy before lunch

**Situation.** The orders team is spinning up a new service and needs dev, staging and prod accounts. In the old world this was 11 tickets across network, security, identity and finance, and about three weeks.

**What happened.** The team lead opened a PR with three account requests at 09:10. The platform team approved at 09:25. AFT queued the requests; the three accounts were in their OUs by about 10:40, and global and `eks-prod` customizations finished around 11:00. At 11:05 the team signed in through Identity Center with the permission sets their Entra ID groups map to, and their pipeline, using OIDC roles the customizations had created, deployed a hello-world service to dev.

**Why it worked.** There were no decisions left to make after the merge. The CIDR came from IPAM, the route table was chosen by template, the budget came from the request, access came from groups. The platform team's job moved from doing the work to reviewing a 30-line diff.

### 2. Bringing in an acquisition: 37 accounts in six weeks

**Situation.** The group acquired a smaller company running 37 AWS accounts in its own organization. Discovery found 23 IAM users with console access, 9 active access keys older than two years (one with `AdministratorAccess`), workloads in four regions, CloudTrail enabled in only some accounts, and a payer account holding Reserved Instances.

**What happened.**

- **Week 1.** A read-only audit role was deployed into all 37 accounts through the acquired org's StackSets. An inventory of regions, IAM users, keys, public resources and spend went into one spreadsheet, which became the migration tracker.
- **Week 2.** A Transitional OU was created with only the root-level SCP (protect the audit trail, no leaving the org) and no region deny, because the acquired workloads ran in two regions outside the allowed list.
- **Weeks 2 to 4.** Accounts were removed from the old organization and invited to the new one in waves of eight to ten, lowest-risk first. Each was then enrolled into Control Tower, which brought it into the org trail, Config and GuardDuty. The usual enrolment blockers were pre-existing Config recorders and missing execution roles; a short runbook covered both.
- **Weeks 3 to 5.** Every IAM user was replaced with Identity Center access, and every access key was rotated out and deleted. The two out-of-region workloads moved accounts into Exceptions with a dated region exception while their migration was planned.
- **Week 6.** 31 accounts moved from Transitional into Workloads; 4 went to Exceptions; 2 unused ones went to Suspended for closure.

**The numbers.** Time with active long-lived admin keys after day one: 0 days, because those keys were the first thing rotated. CloudTrail coverage went from 61% of accounts to 100% within three weeks. The RI benefit started applying across the group's consolidated bill once the payer joined, which nobody had budgeted for and finance was happy about.

**Lesson.** The Transitional OU is what makes this calm. Moving 37 accounts straight under strict prod SCPs would have broken things on the first afternoon and turned the migration into a fight.

### 3. A stolen laptop and a live session

**Situation.** At 19:40 on a Friday a contractor reported their laptop stolen from a car. They had signed in to the AWS access portal that afternoon and had an active ProdOperator elevation for `orders-prod` that was due to expire at 20:15.

**What happened.** The IdP account was disabled at 19:48. That stops new sign-ins, but it doesn't kill AWS credentials already issued: the role session from the elevation was valid until it expired. So the on-call engineer did two things. The elevation workflow revoked the assignment, and they used the IAM console's [revoke active sessions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html) action on the `AWSReservedSSO_ProdOperator` role in `orders-prod`, which adds a policy denying any session issued before that moment. Total time from report to no valid credentials: 14 minutes. CloudTrail showed no calls from the session after 17:02.

**Lesson.** The one-hour session on ProdOperator is what made this a non-event. With a 12-hour admin session, the window would have run until morning. Practise session revocation; most teams have never done it.

### 4. The SCP that broke 19 teams

This is the failure in diagram 5. A region-deny SCP allowing only `eu-west-1` and `eu-central-1` went straight to the Workloads OU on a Tuesday at 10:00. At 10:04 CloudFront deployments started failing: a certificate used by a CloudFront distribution has to be requested in `us-east-1`, and `acm:*` wasn't exempt there. By 10:20 there were 47 failed pipeline runs across 19 accounts. Someone detached the policy by hand at 10:31.

The fix took an hour. The process change took a week: the Policy Staging OU, the canary accounts with a daily CloudFront deployment, the Athena query, and the rule that nobody attaches an SCP from the console. It hasn't happened again, and two later policy bugs were caught in staging.

### 5. "Show me nobody deleted the logs"

**Situation.** The annual PCI DSS assessment asked for evidence that audit logs for the cardholder data environment were retained for 12 months and couldn't have been altered.

**Before.** Three engineers spent most of three weeks pulling CloudTrail exports, screenshots of bucket policies and IAM reports from individual accounts.

**After.** The evidence was: the organization trail configuration, the Object Lock compliance-mode retention on the evidence bucket, CloudTrail digest validation for a sample of days, the bucket policy, and an Athena query showing continuous delivery for `payments-prod` across the period. Two days, one engineer, and the assessor accepted it without follow-up questions.

### 6. A sandbox, a weekend and a GPU instance

**Situation.** An engineer testing a model in their sandbox account launched a large GPU instance on Friday afternoon and forgot it. The sandbox budget is $150 a month.

**What happened.** The [budget action](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html) at 100% of the budget attached an SCP denying `ec2:RunInstances` and similar actions to the account on Saturday morning, and the weekly sandbox cleanup stopped the running instance. Total spend: $212, against roughly $2,400 if it had run until Monday. The engineer got an email, not a conversation with finance.

**Lesson.** Budgets are alarms; budget actions are controls. Use actions where an overrun is never worth it.

## Mapping to the AWS Well-Architected Framework

Governance is mostly a Security and Cost Optimization topic, but every pillar has a stake in it. The best-practice IDs refer to the current [Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html) pillars.

| Pillar | Relevant best practices | How this design addresses them |
|---|---|---|
| **Operational excellence** | Use infrastructure as code; make frequent, small, reversible changes; learn from failures | Accounts, permission sets, assignments and guardrails are all code. Guardrails roll out through staging with a rehearsed rollback. Incident 4 changed the process, not just the policy |
| **Security** | SEC01-BP01 separate workloads using accounts; SEC01-BP02 secure account root user and properties; SEC02-BP04 rely on a centralized identity provider; SEC03-BP03 establish an emergency access process; SEC04 detect and investigate security events | One account per team per environment; root credentials removed centrally; Identity Center with SCIM; tested break-glass; org trail, Security Hub CSPM, GuardDuty and routed findings |
| **Reliability** | REL01-BP02 manage service quotas across accounts and regions; limit blast radius | Quotas are per account, so one team's spike can't exhaust another's. Service Quotas request templates set higher quotas at vending. A bad deploy or a compromised role affects one account |
| **Performance efficiency** | Experiment more often; choose locations deliberately | Sandbox accounts let engineers try new services in minutes without a ticket; the allowed region list is a deliberate decision rather than an accident |
| **Cost optimization** | COST02-BP03 implement an account structure; COST02-BP05 implement cost controls; COST03 monitor usage and cost | Account-per-team gives cost attribution without perfect tagging; tag policy covers shared accounts; budgets and budget actions per account; CUR 2.0 in the management account |
| **Sustainability** | Remove unused resources; choose regions deliberately | Sandbox cleanup and Suspended OU stop idle resources; budget actions stop forgotten instances; region choice includes the carbon intensity of the grid |

## A realistic rollout for an existing estate

Few companies start from a clean slate. For an estate that already has a few dozen accounts, this order has worked:

1. **Weeks 1 to 2: visibility first.** Turn on the organization trail, GuardDuty and Security Hub CSPM org-wide with a delegated admin. Change nothing else. You need to see what you have before you restrict it.
2. **Weeks 2 to 4: Control Tower and the OU structure.** Set up or upgrade the landing zone, create the OUs, and move existing accounts in with only the root-level protective SCP.
3. **Weeks 4 to 8: identity.** Identity Center with SCIM, permission sets in Terraform, migrate people off IAM users team by team. Then deny new IAM users by SCP.
4. **Weeks 6 to 10: vending.** AFT for all new accounts. Back-fill global customizations into existing accounts.
5. **Weeks 8 to 12: guardrails through staging.** Region deny, IMDSv2, the RCP data perimeter, declarative policies, each through the Policy Staging OU.
6. **Ongoing:** quarterly break-glass test, quarterly exception review, landing zone and AFT upgrades on a schedule.

## Mistakes I'd avoid

- **OUs that mirror the org chart.** You'll be moving accounts every reorganisation, and each move is a chance to attach the wrong policy.
- **Running anything in the management account.** No SCP or RCP protects it. Billing and organization administration only.
- **Attaching SCPs from the console.** Every guardrail change should be a reviewed diff with a rollback.
- **A single 5,000-character "do everything" SCP.** It hits the size limit, nobody can review it, and you can't stage half of it.
- **Long permission-set sessions for write access.** Eight hours of read-only is fine. Eight hours of admin is an incident waiting for a stolen laptop.
- **Forgetting the exit.** Without a Suspended OU and a closure process, retired accounts keep their resources, their access and their bill.
- **Treating the landing zone as a project.** It's a product with users (every engineering team), a backlog and upgrades. Give it an owner.

## Checklist

- OUs designed by policy: Security, Infrastructure, Workloads (Prod, NonProd), Sandbox, Policy Staging, Exceptions, Transitional, Suspended
- Control Tower landing zone on a current version; drift checked weekly
- AFT (or CfCT/LZA) vending; no accounts created by hand
- Global baseline: no default VPCs, S3 Block Public Access, EBS encryption, Access Analyzer, alternate contacts, root credentials removed
- Root SCP protecting the trail, detectors and organization membership
- RCP data perimeter on Workloads; declarative policies for EC2 at the root
- SCP/RCP changes validated in CI, staged in Policy Staging, monitored for `AccessDenied`
- Identity Center with SCIM, seven-ish permission sets, ABAC on team tags
- Zero standing prod-write access; elevation for one hour with a second approver
- CI through OIDC; SCP denies IAM users and access keys
- Break-glass users tested quarterly; console login pages security on-call
- Org trail to Log Archive, Object Lock evidence copy, integrity validation on
- Security Hub CSPM central configuration, GuardDuty auto-enable, Config aggregator, from the Audit account
- Findings routed by severity with owners from account tags
- Budgets on every account; budget actions on Sandbox

## Download the diagrams

All five diagrams are editable in [draw.io](https://app.diagrams.net/) (File, Open from, Device):

- [All five diagrams in one file](/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-governance.drawio)
- [Organization and OU design](/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-org-structure.drawio)
- [Account vending with AFT](/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-account-vending.drawio)
- [Identity and access](/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-identity-access.drawio)
- [Central logging and detection](/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-logging-detection.drawio)
- [Guardrail rollout](/assets/diagrams/aws-landing-zone-governance/aws-landing-zone-guardrail-rollout.drawio)

## Further reading (AWS documentation)

- [Organizing your AWS environment using multiple accounts](https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/organizing-your-aws-environment.html)
- [What is AWS Control Tower?](https://docs.aws.amazon.com/controltower/latest/userguide/what-is-control-tower.html)
- [AWS Control Tower Account Factory for Terraform (AFT)](https://docs.aws.amazon.com/controltower/latest/userguide/aft-overview.html)
- [AWS Control Tower controls reference](https://docs.aws.amazon.com/controltower/latest/controlreference/introduction.html)
- [Service control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- [Resource control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_rcps.html)
- [Declarative policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_declarative.html)
- [Quotas for AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_reference_limits.html)
- [What is IAM Identity Center?](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html)
- [Attribute-based access control in IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/abac.html)
- [Root user best practices and centralized root access](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user.html)
- [Revoking IAM role temporary security credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html)
- [Creating a trail for an organization](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/creating-trail-organization.html)
- [Security Hub central configuration](https://docs.aws.amazon.com/securityhub/latest/userguide/central-configuration-intro.html)
- [AWS services that you can use with AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_integrate_services_list.html)
- [Configuring AWS Budgets actions](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html)
- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
