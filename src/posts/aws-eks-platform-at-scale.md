---
title: "Running an EKS microservices platform at scale: tenants, Karpenter, IP exhaustion and upgrades"
description: "How to design a shared Amazon EKS platform for dozens of product teams: requirements, cluster and tenancy model, Karpenter node pools, VPC CNI custom networking and prefix delegation, VPC Lattice for east-west traffic, observability and a safe upgrade process. With two real scenarios, mapped to the AWS Well-Architected Framework, and four editable draw.io diagrams."
date: 2026-11-21T03:09:00Z
category: Cloud & DevOps
coverLabel: "38 teams.\nOne cluster.\nNo IPs left."
coverCode: "100.64.0.0/16 · maxPods: 110"
coverLogos: "aws, kubernetes"
coverImage: /assets/images/covers/aws-eks-platform-at-scale.jpg
coverImageAlt: "Cloud & DevOps cover reading '38 teams. One cluster. No IPs left.', with the AWS and Kubernetes logos."
---
Running one EKS cluster for one team is a weekend project. Running a platform that 38 product teams deploy to all day, that scales from 3,500 to almost 10,000 pods for a sale, and that has to move to a new Kubernetes version every few months without anyone noticing, is a different job. The hard parts are rarely Kubernetes itself. They are IP addresses, noisy neighbours, who is allowed to call what, and the upgrade you put off until it is urgent.

This article is the design I'd use for that platform on AWS, and the reasoning behind each choice. It follows one company through two things that actually happen to platforms like this: a load test that ran the VPC out of IP addresses, and a Kubernetes upgrade with a hard deadline.

The company is a composite: a European online marketplace with 38 product teams and about 420 services. The numbers are realistic sizing, not a specific customer. Swap in your own.

<figure class="diagram wide"><a href="/assets/diagrams/aws-eks-platform/eks-platform.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-eks-platform/eks-platform.svg" alt="Reference architecture. Customers reach an internet gateway and a shared ALB in the public subnets of a platform VPC in eu-west-1. The VPC has a routable primary CIDR 10.40.0.0/16 and a secondary CIDR 100.64.0.0/16 used only for pods. The public subnets also hold an NLB for gRPC and TCP tenants and three NAT gateways. Inside, the EKS cluster prod-euw1 on Kubernetes 1.35 contains Karpenter node pools (system on-demand arm64, general Spot plus on-demand, and a tainted search-batch Spot pool, running Bottlerocket or AL2023), tenant namespaces for checkout, catalog, search, payments-api, loyalty and 33 more teams, each with quotas, default-deny network policy, Pod Security Admission restricted, Kyverno policies, scoped access entries, Pod Identity and a cost label, and platform add-ons: VPC CNI with custom networking, prefix delegation and the network policy agent, CoreDNS with NodeLocal DNSCache, the AWS Load Balancer Controller, the AWS Gateway API Controller for VPC Lattice, the EKS Pod Identity Agent, an ADOT collector, Kyverno, the EBS CSI driver, metrics-server and KEDA. The cluster runs about 120 nodes and 3,500 pods normally and 300 nodes and 9,600 pods at peak. Node subnets are three routable /20s holding 12,273 addresses; pod subnets are three /18s in 100.64.0.0/16 holding 49,137 addresses. Below the VPC, a Transit Gateway reaches shared services and on-premises, and a separate payments EKS cluster in a PCI account is reached only through VPC Lattice. On the right, the regional services: the EKS control plane, SQS and EventBridge for Spot interruptions, VPC Lattice, ECR, Amazon Managed Service for Prometheus, Amazon Managed Grafana, CloudWatch, X-Ray, IAM, Secrets Manager, KMS, GuardDuty and CUR 2.0 split cost allocation." width="1600" height="1060" loading="lazy"></a><figcaption>The platform: one shared cluster per environment and region, Karpenter for nodes, pods in their own address range, and VPC Lattice to reach anything outside the cluster.</figcaption></figure>

## The short version

- **Few clusters, many namespaces.** One shared cluster per environment per region, plus separate clusters (in separate accounts) only where you need a real security boundary, such as PCI.
- **Tenancy is a product.** Every team gets the same namespace kit from one Git manifest: quotas, default-deny network policy, Pod Security "restricted", scoped access, Pod Identity and a cost label. Nobody hand-builds a namespace.
- **Karpenter with a small number of node pools.** A system pool, a general pool with Spot and on-demand across many instance types, and tainted pools only for workloads that would otherwise hurt their neighbours.
- **Plan pod IPs before they run out, not after.** With the default VPC CNI, every pod takes a VPC address and every node hoards spares. Give pods their own non-routable range with custom networking, and hand out addresses in `/28` prefixes.
- **East-west across clusters and accounts goes through VPC Lattice.** Inside a cluster, plain Services plus network policy are enough. AWS App Mesh reached end of support on 30 September 2026, so don't start anything new on it.
- **Upgrade on a calendar, not when forced.** Each Kubernetes version gets 14 months of standard support on EKS. Extended support buys 12 more months at six times the control plane price. Upgrade in place, roll nodes with Karpenter drift, and keep the drain guardrails honest.

## Requirements

A platform without written requirements turns into whatever the loudest team asked for last. These are the ones this design is built to meet.

**Functional**

- A new team gets a working namespace, CI access, IAM roles for its services, dashboards and a cost report in **under one working day**, without a ticket to the platform team for each piece.
- Teams deploy independently, many times a day, without needing cluster-admin.
- Services call each other inside the cluster, across clusters and across AWS accounts, with **authorization per caller**, not just "anything in the VPC".
- Each team can see its own metrics, logs, traces and cost, and only its own.

**Non-functional**

| Requirement | Target |
| --- | --- |
| Availability of tier-1 services (checkout, search, catalog) | 99.95% per month |
| Loss of one Availability Zone | No manual action, no customer-visible errors beyond retries |
| Scale-out for a sale | 3,500 to 9,600 pods in under 10 minutes |
| Pod start, including a new node when needed | p95 under 90 seconds |
| Kubernetes version | Always in standard support; one minor upgrade per quarter |
| Upgrade impact | Zero SLO alerts during an upgrade |
| Spot and Graviton share for stateless workloads | At least 60% of vCPU hours |
| Cost visibility | Monthly cost per namespace, within 5% |

**Constraints**

- The network team allocates address space from Amazon VPC IPAM. The platform got **one routable /16** per region, and getting another takes a quarter.
- Payments is in PCI scope and must not share nodes, a control plane or a VPC with anything else.
- An acquired business runs services in an account whose VPC uses the same CIDR, `10.40.0.0/16`.

That first constraint is the one that bites in Scenario 1.

## Design decisions

### How many clusters

Cluster per team sounds clean until you count: 38 teams times three environments is 114 control planes to upgrade, patch, monitor and keep in sync. The control plane fee is the small part (EKS charges $0.10 per cluster-hour in standard support, about $73 a month). The real cost is people: every cluster is a separate upgrade, a separate set of add-ons and a separate place where something drifts.

So the default is **one shared cluster per environment per region**: `dev-euw1`, `stg-euw1`, `prod-euw1`, and the same again in the second region. A team gets a separate cluster only when it needs a boundary that namespaces cannot give:

- **Regulated scope.** Payments runs `payments-euw1` in its own PCI account and VPC.
- **Cluster-wide privileges.** Anything that needs its own CRDs, admission webhooks or cluster-admin.
- **Untrusted code.** Customer-supplied plugins, build runners for third parties.
- **Blast radius.** A workload that is allowed to take its own cluster down, but nobody else's.

Namespaces are not a security boundary against a hostile workload. The kernel, the nodes and the API server are shared. They are a good boundary between teams who trust each other and share a release process, which is most of a company.

### Tenancy: the namespace kit

Every namespace comes from the same Git manifest, rendered by the platform's tenant chart and applied by the GitOps controller. A tenant entry is about ten lines; the chart turns it into everything below.

- **ResourceQuota and LimitRange** so one team can't take the whole cluster and every container gets default requests. Checkout's quota in prod is 120 vCPU, 240 GiB and 400 pods.
- **A default-deny NetworkPolicy**, then explicit allows. The Amazon VPC CNI enforces Kubernetes network policies natively with its eBPF network policy agent, so there is no separate CNI to run. I've written about [why default deny matters](/blog/kubernetes-network-policies-default-deny/).
- **Pod Security Admission at `restricted`** plus Kyverno rules for what PSA doesn't cover: images only from our ECR, no `hostPath`, and a PodDisruptionBudget only if the workload has at least two replicas (Scenario 2 explains that one).
- **EKS access entries** instead of the old `aws-auth` ConfigMap. Each team's IAM role gets `AmazonEKSEditPolicy` scoped to its own namespaces:

```bash
aws eks create-access-entry --cluster-name prod-euw1 \
  --principal-arn arn:aws:iam::111122223333:role/team-catalog-deployers

aws eks associate-access-policy --cluster-name prod-euw1 \
  --principal-arn arn:aws:iam::111122223333:role/team-catalog-deployers \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy \
  --access-scope type=namespace,namespaces=catalog
```

- **EKS Pod Identity** for AWS access, one IAM role per service account. Pod Identity needs no per-cluster OIDC provider, and the association lives in EKS while the permissions live in IAM, which keeps the duties of the platform team and the security team apart:

```bash
aws eks create-pod-identity-association --cluster-name prod-euw1 \
  --namespace checkout --service-account checkout-api \
  --role-arn arn:aws:iam::111122223333:role/checkout-prod
```

- **A `cost-center` label** on the namespace, which flows into split cost allocation data for EKS in the Cost and Usage Report, so each team sees its own bill.

### Compute: Karpenter and a few node pools

Karpenter replaces node groups with a controller that looks at pending pods and launches the cheapest instance that fits. The temptation is to give every team a NodePool. Don't. Each extra pool fragments capacity and makes bin-packing worse. Three pools cover almost everything:

| NodePool | Capacity | Who runs there |
| --- | --- | --- |
| `system` | On-demand, arm64, 3 to 6 nodes, tainted `CriticalAddonsOnly` | Karpenter itself, CoreDNS, the GitOps controller, Kyverno |
| `general` | Spot and on-demand, arm64 and amd64, `c`/`m`/`r`, 4 to 16 vCPU | Every stateless tenant service |
| `search-batch` | Spot only, tainted `team=search` | Reindex jobs that would otherwise eat a node each |

The `general` pool, trimmed to the parts that matter:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64", "amd64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-cpu
          operator: In
          values: ["4", "8", "16"]
      expireAfter: 720h
      terminationGracePeriod: 24h
  limits:
    cpu: "2400"
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
    budgets:
      - nodes: "10%"
      - schedule: "0 17 * * *"   # UTC; no voluntary disruption in the evening peak
        duration: 5h
        nodes: "0"
        reasons: ["Underutilized", "Empty", "Drifted"]
```

A few things in there earn their place:

- **Wide instance requirements.** Spot is reliable when you let Karpenter choose from many instance types; it uses the price-capacity-optimized strategy across them. Pinning to two types is how you get interrupted all at once.
- **`limits.cpu`** stops a bad HPA or a runaway job from launching a thousand nodes.
- **Budgets** cap voluntary disruption to 10% of nodes, and to zero during the evening peak. Spot interruptions still happen whenever AWS needs the capacity back, so point Karpenter's interruption queue at the SQS queue fed by EventBridge rules for Spot interruption warnings, rebalance recommendations and instance state changes. Karpenter then cordons and drains the node during the two-minute warning instead of losing it cold.
- **`expireAfter: 720h`** replaces every node at least every 30 days, which keeps AMIs fresh even when nobody touches the config.

The matching EC2NodeClass pins the AMI, so new images arrive by pull request instead of by surprise:

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: general
spec:
  role: KarpenterNodeRole-prod-euw1
  amiSelectorTerms:
    - alias: al2023@v20261110   # example release: pinned, bumped by PR
  subnetSelectorTerms:
    - tags: { karpenter.sh/discovery: prod-euw1, tier: nodes }
  securityGroupSelectorTerms:
    - tags: { karpenter.sh/discovery: prod-euw1 }
  kubelet:
    maxPods: 110
```

**Or let AWS run it.** EKS Auto Mode runs Karpenter, the VPC CNI, the EBS CSI driver and the load balancer controller for you, on locked-down immutable AMIs, and replaces nodes at most every 21 days. For a team without a dedicated platform group it is the better default. This design self-manages Karpenter because it needs custom networking and specific CNI settings, and wants to choose exactly when nodes roll.

### Networking: plan pod IPs first

With the Amazon VPC CNI, every pod gets a real VPC IP address. That's great for everything else in the VPC (load balancers send straight to pods, security groups for pods work, flow logs show pod IPs) and it is also how platforms run out of addresses.

Two things use up IPs faster than people expect:

1. **Pods and nodes share the subnets.** A `/20` per AZ looks huge for 120 nodes. It isn't for 3,500 pods plus their spares.
2. **Nodes hold spare addresses.** By default (`WARM_ENI_TARGET=1`) each node keeps one whole spare network interface of secondary IPs attached, so pods start fast. On an `m7g.2xlarge` (4 interfaces, 15 IPv4 each) that's 15 idle addresses per node, whether you need them or not.

The options, in the order I'd reach for them:

| Option | What it does | Watch out for |
| --- | --- | --- |
| Tune warm targets (`WARM_IP_TARGET`, `MINIMUM_IP_TARGET`) | Fewer idle IPs per node | More EC2 API calls, slower pod start during bursts |
| Prefix delegation | Hands out `/28` blocks (16 IPs) per slot instead of single IPs | Needs contiguous free `/28`s; fragmented subnets fail |
| Custom networking | Pods use ENIs in different subnets, e.g. a `100.64.0.0/16` secondary CIDR | The primary ENI no longer hosts pods, so max pods per node drops unless you also use prefixes |
| IPv6 cluster | Pods get IPv6 addresses, effectively unlimited | Chosen at cluster creation; everything the pods call must cope with IPv6 or go through egress translation |

For an existing IPv4 platform with a fixed routable range, the answer is **custom networking plus prefix delegation**. For a new cluster where every dependency speaks IPv6, IPv6 is the cleaner long-term answer. Scenario 1 shows the switch.

### East-west traffic: Services, Lattice, or a mesh

Inside one cluster, a ClusterIP Service plus a NetworkPolicy is enough for most calls. Add `trafficDistribution: PreferClose` on chatty Services so traffic prefers endpoints in the same zone; cross-AZ data transfer is billed in both directions and adds up fast at this size.

Across clusters and accounts it gets harder. The payments cluster is in another account and VPC, and the acquired business's VPC overlaps ours, so routing between them is off the table.

| Option | Good at | Costs you |
| --- | --- | --- |
| Plain Services + NetworkPolicy | In-cluster calls; zero extra moving parts | Nothing across clusters, no per-request auth |
| **Amazon VPC Lattice** | Cross-VPC and cross-account service calls, overlapping CIDRs, IAM auth per request, works for EKS, ECS, Lambda and instances | Per-service and per-request charges; HTTP/gRPC/TLS-passthrough focus; your code (or a proxy) must SigV4-sign requests to use IAM auth |
| Istio (ambient or sidecars) | mTLS everywhere, rich traffic policy, retries and fault injection in-cluster | You operate it, upgrade it and debug it |
| AWS App Mesh | Nothing new: support ended 30 September 2026 | Migration work if you're still on it |

This platform uses **VPC Lattice for anything that leaves the cluster** and plain Services inside it. If a team later needs mTLS between every pod, Istio ambient mode can be added inside the cluster without changing how cross-account calls work.

<figure class="diagram wide"><a href="/assets/diagrams/aws-eks-platform/eks-tenancy-lattice.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-eks-platform/eks-tenancy-lattice.svg" alt="Tenant isolation and east-west traffic. In account platform-prod, the shared EKS cluster prod-euw1 holds namespace checkout (team A) with checkout-api using service account checkout-api mapped by Pod Identity to IAM role checkout-prod and a quota of 120 vCPU, 240 GiB and 400 pods; namespace catalog (team B) with an access entry for team-b-devs using AmazonEKSEditPolicy scoped to the namespace; and namespace search (team C) on its own tainted Spot NodePool, where search-api only accepts ingress from catalog, so checkout to search is denied by default-deny network policy. Guardrails every namespace gets: network policy, Pod Security restricted, Kyverno rules, quotas, limit ranges, priority classes, access entries and Pod Identity. A note explains that hard tenancy such as PCI goes in its own cluster and account. In the middle, a VPC Lattice service network prod-services, shared with RAM, with an auth policy on the payments service allowing only role checkout-prod to POST /v1/authorizations. In account payments-pci, the payments-euw1 cluster has an HTTPRoute that the AWS Gateway API Controller turns into a Lattice service with a target group of payments-api pod IPs, and the node security group allows only the Lattice managed prefix list. In account orders-legacy, whose VPC overlaps at 10.40.0.0/16, an invoice service on ECS Fargate calls catalog through Lattice and a refund-worker Lambda is a Lattice target. Numbered steps: 1 HTTPRoute becomes a Lattice service, 2 checkout calls payments SigV4-signed with Pod Identity credentials, 3 the auth policy checks the IAM principal, 4 Lattice forwards to payments pod IPs, 5 invoice in the overlapping VPC calls catalog." width="1600" height="980" loading="lazy"></a><figcaption>Namespaces and policy keep teams apart inside the shared cluster. VPC Lattice connects the clusters and accounts that must stay apart, with IAM deciding who may call what.</figcaption></figure>

In the payments cluster, the AWS Gateway API Controller turns ordinary Gateway API objects into Lattice resources. The Gateway maps to the service network, and each HTTPRoute becomes a Lattice service with a target group of pod IPs:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-api
  namespace: payments-api
spec:
  parentRefs:
    - name: prod-services        # Gateway backed by the Lattice service network
      sectionName: https
  rules:
    - backendRefs:
        - name: payments-api
          kind: Service
          port: 8443
```

And the auth policy on that Lattice service only lets checkout's role make one kind of call:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::111122223333:role/checkout-prod" },
    "Action": "vpc-lattice-svcs:Invoke",
    "Resource": "*",
    "Condition": {
      "StringEquals": { "vpc-lattice-svcs:RequestMethod": "POST" },
      "StringLike": { "vpc-lattice-svcs:RequestPath": "/v1/authorizations*" }
    }
  }]
}
```

Two details people miss. The nodes behind a Lattice target group must allow inbound traffic from the VPC Lattice managed prefix list in their security group, or every health check fails. And IAM auth means the caller signs requests with SigV4 for the `vpc-lattice-svcs` service; checkout uses the AWS SDK signer with the credentials Pod Identity already gives it.

### Observability: per tenant, and for the platform itself

Two audiences, two sets of signals.

**For teams**, each gets the golden signals for its own services and nothing else:

- **Metrics:** Amazon Managed Service for Prometheus, scraped by its managed collectors so there's no Prometheus server in the cluster to babysit, and Amazon Managed Grafana with a folder per team.
- **Traces:** an ADOT (OpenTelemetry) collector sends traces to AWS X-Ray, and CloudWatch Application Signals builds service maps and SLOs from them.
- **Logs:** Fluent Bit to CloudWatch Logs, a log group per namespace, retention set by the tenant manifest.
- **SLO alerts** on burn rate, not on CPU. Checkout's alert fires when it is burning its monthly error budget 14 times faster than allowed for five minutes.

**For the platform team**, the signals that predict the next incident:

- **Free IPs per pod subnet** and the VPC CNI's own metrics (`awscni_total_ip_addresses` against `awscni_assigned_ip_addresses`). Alarm at 70% used, well before Scenario 1 happens again.
- **Pending pods older than 60 seconds** and Karpenter launch errors.
- **CoreDNS latency and errors**, plus the ENA `linklocal_allowance_exceeded` counter on nodes. Each network interface can send at most 1,024 packets per second to the Amazon-provided DNS resolver; with the default `ndots: 5` a single lookup can become five queries. NodeLocal DNSCache and fully qualified names for external hosts keep you under it.
- **EKS control plane logs**, at least `audit` and `authenticator`, into CloudWatch Logs. The audit log is also what tells you who still calls a deprecated API before an upgrade.
- **Cluster upgrade insights**, checked weekly, not just before an upgrade.

### Upgrades: a calendar, not an emergency

The facts that drive the process:

- A minor version gets **14 months of standard support** on EKS, then **12 months of extended support** at extra cost. At the time of writing, a cluster in extended support pays $0.60 per cluster-hour instead of $0.10.
- When extended support ends, EKS **upgrades the control plane for you**. Your nodes and add-ons stay behind, which is not a state you want to discover on a Monday.
- The control plane moves **one minor version at a time**. Kubelets may run up to three minor versions behind the API server, which gives you room to roll nodes after the control plane, not at the same moment.
- After an in-place upgrade, you can **roll the control plane back** to the previous minor version within 7 days. It doesn't roll back add-ons or nodes, but it turns a bad upgrade from a rebuild into an API call.

As I write this (November 2026), 1.34, 1.35 and 1.36 are in standard support, and **1.34 leaves standard support on 2 December 2026**. That date is Scenario 2.

## Scenario 1: the load test that ran out of IP addresses

Six weeks before Black Friday, the platform team ran the annual sale test: replay last year's peak at 1.5 times the volume, target 9,600 pods. The cluster still had the default VPC CNI settings from the day it was built.

<figure class="diagram wide"><a href="/assets/diagrams/aws-eks-platform/eks-ip-exhaustion.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-eks-platform/eks-ip-exhaustion.svg" alt="IP exhaustion scenario. Before: with the default VPC CNI, pods share the node subnet 10.40.0.0/20. An m7g.2xlarge node with 4 ENIs of 15 IPv4 addresses each, max 58 pods, has ENI 0 with the node IP and 14 pod IPs, ENI 1 with 15, ENI 2 with 15 of which 3 are in use, and ENI 3 as a warm spare with 15 idle addresses because WARM_ENI_TARGET is 1. 32 pods hold 60 VPC IPs. Three /20 node subnets give 12,273 usable addresses; 205 nodes times about 60 IPs is about 12,300, more than available. During the load test at about 205 nodes and 6,400 pods, kubelet reports FailedCreatePodSandBox, failed to assign an IP address to container, and Karpenter reports InsufficientFreeAddressesInSubnet. Checkout p99 rises from 180 ms to 2.4 s and the test is stopped at 67 percent. Quick relief: MINIMUM_IP_TARGET=30 and WARM_IP_TARGET=4. After: the node's primary ENI stays in the routable node subnet with only the node IP, while ENIs 1 to 3 live in pod subnet 100.64.0.0/18 via ENIConfig and get /28 prefixes; with WARM_PREFIX_TARGET=1 a node holds 48 IPs for 32 pods; maxPods is 110 with RESERVED_ENIS=1 for Karpenter; subnet CIDR reservations keep /28 blocks contiguous. Three /18 pod subnets give 49,137 usable addresses against about 14,400 needed for 300 nodes. The retest ran 9,600 pods on 296 nodes with zero IP errors and pod start p95 down from 21 to 9 seconds. Traffic flows: the ALB sends to pod IPs inside the VPC; traffic leaving the VPC is SNATed to the node IP so 100.64.0.0/16 needs no routes elsewhere; cross-VPC service calls go through VPC Lattice." width="1600" height="1000" loading="lazy"></a><figcaption>Same nodes, same pods. The fix was giving pods their own address range and handing addresses out sixteen at a time.</figcaption></figure>

**What happened.** At 19:40 the HPAs started asking for pods. Karpenter launched nodes. At around 205 nodes and 6,400 pods, new pods stopped at `ContainerCreating` with `FailedCreatePodSandBox ... failed to assign an IP address to container`, and Karpenter's launches started failing with `InsufficientFreeAddressesInSubnet`: new nodes couldn't even get a primary IP. Checkout p99 went from 180 ms to 2.4 seconds and the test was stopped at 67% of the target.

**Why.** Each node was holding about 60 addresses for about 32 pods: its in-use IPs, plus a full spare interface. Three `/20` node subnets have 12,273 usable addresses (AWS reserves five in every subnet). 205 nodes times 60 is roughly 12,300. The math was always going to fail; nobody had done it.

**Relief that night.** Setting `MINIMUM_IP_TARGET=30` and `WARM_IP_TARGET=4` on the CNI cut the hoarding to about 36 addresses per node. That bought headroom to about 340 nodes, at the cost of more EC2 API calls and slower pod starts during bursts. Fine for a week, not a design.

**The fix, two weeks later.**

1. **Add a secondary CIDR to the VPC**, `100.64.0.0/16`, and carve three `/18` pod subnets, one per AZ. That range is not routable outside the VPC, so it doesn't need anything from the IPAM queue.
2. **Turn on custom networking** with an `ENIConfig` per AZ, so pod interfaces land in the pod subnets while each node's primary interface stays in its routable node subnet:

```yaml
apiVersion: crd.k8s.amazonaws.com/v1alpha1
kind: ENIConfig
metadata:
  name: eu-west-1a          # matched by the node's zone label
spec:
  subnet: subnet-0a1b2c3d4e5f60001   # 100.64.0.0/18
  securityGroups:
    - sg-0pods0000000000001
```

3. **Turn on prefix delegation** in the `vpc-cni` add-on configuration: `AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG=true`, `ENI_CONFIG_LABEL_DEF=topology.kubernetes.io/zone`, `ENABLE_PREFIX_DELEGATION=true`, `WARM_PREFIX_TARGET=1`.
4. **Fix max pods.** With custom networking the primary interface hosts no pods, so tell Karpenter with `RESERVED_ENIS=1` and set `maxPods: 110` in the EC2NodeClass. With prefixes, an `m7g.2xlarge` could address far more than 110 pods; 110 is the sensible ceiling for an 8 vCPU node.
5. **Reserve prefix space.** A subnet CIDR reservation of type `prefix` keeps contiguous `/28` blocks available, so prefix assignment doesn't fail on a fragmented subnet.
6. **Roll it out with new node pools.** AWS recommends not mixing secondary IPs and prefixes on the same node, so the team created new NodePools pointing at the new EC2NodeClass and drained the old ones under a 10% budget.

**The retest.** 9,600 pods on 296 nodes, zero IP errors. With `WARM_PREFIX_TARGET=1` a node with 32 pods holds 48 addresses (two prefixes in use, one warm), so peak needs about 14,400 of the 49,137 available. Pod scheduled-to-running p95 dropped from 21 to 9 seconds, because one EC2 call now brings 16 addresses instead of one.

**What changes for traffic.** The ALB still sends straight to pod IPs, because it is in the same VPC. When a pod calls something outside the VPC, such as the on-premises ERP over the Transit Gateway, the CNI translates the source to the node's IP, so nothing outside the VPC ever needs a route to `100.64.0.0/16`. Calls to other VPCs and accounts go through VPC Lattice, which proxies requests rather than routing packets, and doesn't care about overlapping CIDRs.

If you want the full path of one request from the internet into a pod, every security group and hop on the way, see [From the internet to an EKS pod](/blog/aws-eks-request-path/).

## Scenario 2: the upgrade with a deadline

The shared clusters ran 1.34. Standard support for 1.34 on EKS ends on 2 December 2026, after which each cluster would pay six times the control plane fee, and the clock on the forced upgrade would start. The team scheduled the move to 1.35 for November: dev, then staging, then prod a week apart.

<figure class="diagram wide"><a href="/assets/diagrams/aws-eks-platform/eks-upgrades.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-eks-platform/eks-upgrades.svg" alt="Upgrade playbook from Kubernetes 1.34 to 1.35. Timeline: dev on 3 November (2 clusters, in place), staging on 10 November with a load test after, prod on 17 November on a Tuesday at 06:00, before 1.34 leaves standard support on 2 December 2026. Steps: 1 read the EKS cluster upgrade insights for deprecated API calls from the audit log, add-on compatibility and kubelet skew, finding two Helm charts on an old API; 2 fix it in Git first, bumping charts, Karpenter and add-ons, with CI checking manifests against the 1.35 API; 3 upgrade the control plane in place one minor version, with a 7-day rollback window; 4 update managed add-ons one by one (VPC CNI, CoreDNS, kube-proxy, Pod Identity Agent, EBS CSI) with a 10-minute soak each; 5 let Karpenter drift the nodes by pointing amiSelectorTerms at the 1.35 AMI release; 6 drain under guardrails: a 10 percent NodePool budget, zero between 17:00 and 22:00, PodDisruptionBudgets and readiness probes, terminationGracePeriod 24 hours; 7 watch SLOs in Managed Grafana: 296 nodes replaced in 2 hours 10 minutes with no SLO alert; 8 close it out and plan 1.36. A callout explains that 14 nodes would not drain for 40 minutes because loyalty-sync had one replica and a PodDisruptionBudget of minAvailable 1; the fix was two replicas, a Kyverno rule that only accepts PDBs for workloads with two or more replicas, terminationGracePeriod as a backstop and a drain-blockers panel. A second box lists when to build a new blue/green cluster instead: more than one minor version behind, changing something set at creation such as IPv6 or the service CIDR, years of unexplained drift, or a stateful system needing a rehearsed reversible cut-over." width="1600" height="860" loading="lazy"></a><figcaption>In place, one minor version, nodes rolled by Karpenter drift under budgets. The calendar is what makes it boring.</figcaption></figure>

**Before touching anything.** EKS cluster insights flagged two Helm charts still calling an API version that 1.35 no longer serves; the audit log showed exactly which service accounts made the calls. Both were fixed in Git, along with new versions of Karpenter and every add-on that support 1.35. CI now checks every manifest against the target API version with a deprecation checker, so the next upgrade starts with this list already empty.

**Control plane.** In place, one minor version, no workload restarts. With the 7-day rollback window, a bad surprise in the API server is an API call to undo, not a rebuild.

**Add-ons, one at a time.** VPC CNI, CoreDNS, kube-proxy, the Pod Identity Agent and the EBS CSI driver, each followed by a ten-minute soak watching DNS errors and pod start times. Changing them all at once is how you end up not knowing which one broke DNS.

**Nodes, through Karpenter drift.** The team bumped `amiSelectorTerms` in the EC2NodeClass to the 1.35 AMI release in one pull request. Karpenter marked every node `Drifted` and replaced them under the NodePool budget: launch the new node first, then cordon and drain the old one, respecting PodDisruptionBudgets and readiness. 296 nodes were replaced in 2 hours 10 minutes with no SLO alert.

**What went wrong.** Fourteen nodes wouldn't drain for 40 minutes. Each ran a pod of `loyalty-sync`, a single-replica deployment with a PodDisruptionBudget of `minAvailable: 1`. That PDB allows zero evictions, ever, so Karpenter waited, exactly as designed. The team scaled `loyalty-sync` to two replicas and the drain finished. The permanent fix was the Kyverno rule from the tenancy kit (a PDB is only accepted if the workload has at least two replicas), `terminationGracePeriod` on every NodePool as a backstop, and a "drain blockers" panel checked before every upgrade.

**When in place isn't the answer.** Build a second cluster and move traffic across when you are more than one minor version behind and can't step through, when you're changing something fixed at creation (IPv6, the service CIDR), or when the cluster has drifted in ways nobody can explain. It costs a second control plane and a second fleet for a few days, and buys a rehearsed, reversible cut-over.

## Mapping to the AWS Well-Architected Framework

| Pillar | What this design does |
| --- | --- |
| **Operational excellence** | Tenants, node pools, add-on versions and AMIs all live in Git and change by pull request. Upgrades follow a quarterly calendar with insights checked weekly. Runbooks for drains and IP alarms. |
| **Security** | Access entries scoped per namespace, Pod Identity per service account, default-deny network policy, Pod Security "restricted", Kyverno admission rules, KMS envelope encryption of Kubernetes secrets, GuardDuty EKS protection and runtime monitoring, PCI workloads in a separate account and cluster, Lattice auth policies per caller. |
| **Reliability** | Three AZs with topology spread, PDBs and budgets on every voluntary disruption, Spot interruption handling, IP capacity planned at 3x peak with alarms at 70%, in-place upgrades with a 7-day control plane rollback. |
| **Performance efficiency** | Karpenter picks right-sized instances across families and architectures, prefix delegation for faster pod start, NodeLocal DNSCache, zone-aware traffic distribution, managed collectors instead of an in-cluster Prometheus. |
| **Cost optimization** | Spot and Graviton for stateless services, consolidation, NodePool CPU limits, split cost allocation per namespace, staying in standard support to avoid the extended support premium. |
| **Sustainability** | Higher utilisation through consolidation and bin-packing, Graviton instances for better performance per watt, nodes that disappear when demand does. |

For the container-specific questions, the Container Build Lens is a good checklist to run against your own platform.

## Things that bite

- **Single-replica workloads with a PDB.** They block every drain, every upgrade and every consolidation. Reject them at admission.
- **One NodePool per team.** Feels tidy, wastes capacity, and multiplies what you have to upgrade. Use taints only for real interference.
- **Unpinned AMIs.** `@latest` means your nodes change when AWS publishes, not when you decide. Pin, then bump by pull request.
- **Forgetting the Lattice prefix list.** Targets look healthy from inside the cluster and fail every Lattice health check.
- **DNS packet limits.** 1,024 packets per second per interface to the VPC resolver sounds like plenty until `ndots: 5` multiplies every lookup. Cache on the node.
- **Cross-AZ chatter.** Ten services calling each other at random across three zones is a line item on the bill. Prefer same-zone endpoints for heavy internal traffic.
- **Treating namespaces as a hard boundary.** They aren't. Put anything that needs one in its own cluster and account.

## When this is too much

For a handful of teams and a few dozen services, start with **EKS Auto Mode** in one cluster per environment, Pod Identity, default-deny network policy and a sensible IP plan (or IPv6) from day one. Skip Lattice until something outside the cluster needs to call in. The habits that are hard to add later are the address plan, the tenant manifest and the upgrade calendar; the rest can come when you need it.

Building the accounts and VPCs under this with Terraform? I've covered [how to structure Terraform across many AWS accounts](/blog/terraform-aws-enterprise-guide/).

## Download the diagrams

All four diagrams are editable draw.io files built with the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and adapt them to your platform. PNG versions are there for slides and docs.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-eks-platform/aws-eks-platform-at-scale.drawio)
- [Reference architecture](/assets/diagrams/aws-eks-platform/eks-platform.drawio) ([PNG](/assets/diagrams/aws-eks-platform/eks-platform.png))
- [Scenario: IP exhaustion and the fix](/assets/diagrams/aws-eks-platform/eks-ip-exhaustion.drawio) ([PNG](/assets/diagrams/aws-eks-platform/eks-ip-exhaustion.png))
- [Tenant isolation and VPC Lattice](/assets/diagrams/aws-eks-platform/eks-tenancy-lattice.drawio) ([PNG](/assets/diagrams/aws-eks-platform/eks-tenancy-lattice.png))
- [Scenario: upgrade playbook](/assets/diagrams/aws-eks-platform/eks-upgrades.drawio) ([PNG](/assets/diagrams/aws-eks-platform/eks-upgrades.png))

The CIDRs, instance types, AMI version, timings and traffic numbers are examples. Measure your own with a load test and a game day before you rely on them.

## References

- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [Container Build Lens (AWS Well-Architected)](https://docs.aws.amazon.com/wellarchitected/latest/container-build-lens/container-build-lens.html)
- [VPC and subnet considerations (EKS Best Practices)](https://docs.aws.amazon.com/eks/latest/best-practices/subnets.html)
- [Understand the Kubernetes version lifecycle on EKS](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html)
- [Update an existing cluster to a new Kubernetes version](https://docs.aws.amazon.com/eks/latest/userguide/update-cluster.html)
- [Best practices for cluster upgrades](https://docs.aws.amazon.com/eks/latest/best-practices/cluster-upgrades.html)
- [Deploy pods in alternate subnets with custom networking](https://docs.aws.amazon.com/eks/latest/userguide/cni-custom-network.html)
- [Assign more IP addresses to Amazon EKS nodes with prefixes](https://docs.aws.amazon.com/eks/latest/userguide/cni-increase-ip-addresses.html)
- [Prefix delegation mode for Linux (EKS Best Practices)](https://docs.aws.amazon.com/eks/latest/best-practices/prefix-mode-linux.html)
- [Limit pod traffic with Kubernetes network policies](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html)
- [Grant IAM users access to Kubernetes with EKS access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
- [Learn how EKS Pod Identity grants pods access to AWS services](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- [Automate cluster infrastructure with EKS Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/automode.html)
- [Karpenter: disruption, budgets and drift](https://karpenter.sh/docs/concepts/disruption/)
- [What is Amazon VPC Lattice?](https://docs.aws.amazon.com/vpc-lattice/latest/ug/what-is-vpc-lattice.html)
- [AWS Gateway API Controller for VPC Lattice](https://www.gateway-api-controller.eks.aws.dev/)
