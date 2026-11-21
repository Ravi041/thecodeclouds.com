---
title: "Hybrid cloud on AWS with Direct Connect and Transit Gateway: resilient links, VPN backup, hybrid DNS and a data centre exit"
description: "A production hybrid design for AWS: four Direct Connect connections at two locations, a Site-to-Site VPN that only wins when DX is gone, Transit Gateway segmentation with inspection, Route 53 Resolver hybrid DNS shared with a Route 53 Profile, a data centre exit plan with real bandwidth maths, and when Outposts is worth it. Mapped to the Well-Architected pillars, with five real incident scenarios and four editable draw.io diagrams."
date: 2026-11-21T03:08:00Z
category: Cloud & DevOps
coverLabel: "Hybrid cloud\nthat survives\na fibre cut."
coverCode: "4 x 10G DX · BFD 0.9 s · VPN backup · TGW"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-hybrid-direct-connect-transit-gateway.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Hybrid cloud that survives a fibre cut.', with the AWS logo."
---
Almost every company that moves to AWS ends up hybrid for longer than it planned. A data centre lease runs another two years. A mainframe isn't going anywhere. A factory needs an answer in five milliseconds, and the nearest Region is 400 km away. The cloud part of that picture is the easy part. The hard part is the path in between: the circuits, the BGP sessions, the DNS that has to work in both directions, and the one Tuesday afternoon when a contractor cuts the wrong fibre.

This article is the hybrid design I'd build on AWS today, for a company that has to run both worlds side by side for years and close one data centre on a deadline. It uses AWS Direct Connect at two locations, a Site-to-Site VPN as a last resort, AWS Transit Gateway as the hub, Route 53 Resolver for DNS, and AWS Outposts for the one workload that can't leave the plant floor. Every choice is mapped to the AWS Well-Architected Framework, and in particular to its Hybrid Networking Lens.

There are four diagrams, each an editable `.drawio` file built with the AWS shapes that ship with draw.io. After the design there are five incidents, written as what happened, what the signals showed and what fixed it.

## The short version

- **Two Direct Connect locations, two connections at each.** That's AWS's maximum resiliency model, the one that comes with a 99.99% SLA. One location, however many ports, is still one building.
- **Transit VIFs into a Direct Connect gateway, then one Transit Gateway per Region.** The DX gateway is global, so a second Region is one more association, not new circuits.
- **Turn on BFD.** Without it a dead link is noticed when the BGP hold timer runs out, which is 90 seconds by default. With it, under a second.
- **VPN is a backup, and routing has to keep it that way.** Advertise exactly the same prefixes over VPN as over DX. A more specific route over VPN wins, every time, on both sides.
- **Route all on-prem traffic through an inspection VPC**, but give bulk migration traffic its own route table so you don't pay firewall processing on 700 TB of disk images.
- **DNS gets its own design.** Resolver inbound and outbound endpoints in one shared VPC, forwarding rules and private zones handed to every account with a Route 53 Profile.
- **Plan the migration from the bandwidth, not the other way round.** 8 Gbps is about 86 TB a day at full rate. Know which number your plan depends on.
- **Outposts only where latency or data residency forces it.** It is AWS hardware in your building, and it still needs a healthy link to its parent Region.

## Requirements

The example company is a manufacturer with two data centres, one in New Jersey and one in Chicago, and three plants in Ohio. The New Jersey lease ends in 18 months. Chicago stays for at least three years because the mainframe and the plant systems live there. The primary Region is us-east-1, with us-east-2 for disaster recovery and as the parent Region for an Outpost at the largest plant.

### Functional

| Requirement | Detail |
| --- | --- |
| Private connectivity | Both data centres reach all AWS VPCs on private IPs. No path to private subnets over the internet. |
| Two Regions | us-east-1 and us-east-2 reachable from on-prem over the same circuits. |
| DNS both ways | AWS workloads resolve `corp.example` (Active Directory DNS on-prem). On-prem resolves `aws.corp.example` (Route 53 private zone). |
| PrivateLink from on-prem | Backups and migration tools reach S3 and other AWS APIs through interface endpoints, over DX. |
| Segmentation | Non-prod can never reach prod. Every on-prem to VPC flow is inspected. |
| Data centre exit | 900 VMs (310 TB of disks), 420 TB of file shares, 38 TB of databases (Oracle 22 TB, SQL Server 16 TB) out of New Jersey in 18 months. |
| Plant workload | The manufacturing execution system (MES) answers line controllers in under 5 ms and keeps running if the WAN is down. |

### Non-functional

| Requirement | Target | Why this number |
| --- | --- | --- |
| Hybrid connectivity availability | 99.99% | Order entry and the warehouse system run in AWS but the warehouses are on-prem. Downtime stops shipping. |
| Failover, single link or router | Under 1 s, no session drops | Database connections from on-prem apps time out at 15 s; nothing should notice. |
| Failover, all of DX | Under 60 s, to a smaller path | Reduced bandwidth is acceptable for hours. A black hole is not. |
| Bandwidth, business | 3 Gbps steady, 5 Gbps peak | Measured on the current MPLS links plus the apps already in AWS. |
| Bandwidth, migration | Up to 8 Gbps for 12 months | Sized from the data volumes and the wave plan below. |
| Capacity after losing a location | Business + migration still fits | 5 + 8 = 13 Gbps, which must fit in what one location can carry. |
| Encryption in transit | All hybrid traffic | Audit finding from the last assessment. |
| Latency, data centre to us-east-1 | Under 10 ms | Chatty client-server apps that move first. |
| IP plan | No overlaps, summarisable | On-prem is 10.0.0.0/10. AWS gets 10.64.0.0/12 (us-east-1) and 10.80.0.0/12 (us-east-2). |

## The architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-reference.svg" alt="Hybrid reference architecture. On the left, data centre A in New Jersey, which exits in 18 months, holds a VMware estate of 900 VMs, 420 TB of file shares, 38 TB of databases, Active Directory DNS for corp.example, DataSync and MGN agents, two edge routers with ASN 65010 and a firewall that is the VPN headend; its address space is 10.0.0.0/11. Data centre B in Chicago, which stays at least three years, holds the mainframe and plant systems, AD DNS, two edge routers with ASN 65020 and a firewall; its address space is 10.32.0.0/11, and a 2 by 10G data centre interconnect links the two sites. Data centre A's routers connect to two 10 Gbps dedicated Direct Connect connections at DX location A in the New York metro; data centre B's routers connect to two more at DX location B in Chicago, giving the maximum resiliency model with four connections on four AWS devices at two locations, all with MACsec. Both firewalls also run Site-to-Site VPN over the internet as a backup, two VPN connections with four tunnels using BGP and ECMP, capped by two 2 Gbps internet circuits. In the AWS Cloud, four transit VIFs with BGP and BFD land on a global Direct Connect gateway with ASN 64512, which is associated with a Transit Gateway in us-east-1 with allowed prefix 10.64.0.0/12. The Transit Gateway, ASN 64600 and shared with RAM, lives in a network account and has route tables: the onprem table holds only static summaries 10.64.0.0/12 and 10.80.0.0/12 pointing to the inspection VPC; prod and nonprod send 10.0.0.0/10 to inspection; nonprod has no route to prod; the inspection table is propagated from every VPC; the migration table is removed when data centre A closes. An inspection VPC runs AWS Network Firewall in appliance mode and inspects every on-prem flow. VPN attachments land on the same Transit Gateway and DX routes win over VPN for the same prefix. Spokes: a shared services VPC 10.72.0.0/16 with Route 53 Resolver inbound and outbound endpoints, interface endpoints and a Managed AD site; prod VPCs 10.64.0.0/14 with EKS, EC2 and RDS; non-prod VPCs 10.68.0.0/14 with no path to prod; and a migration landing VPC 10.74.0.0/16 with MGN staging, DMS and DataSync, replicating over DX on private IPs. In us-east-2, used for DR and as the Outposts parent Region, a second Transit Gateway with ASN 64601 is associated with the same Direct Connect gateway with allowed prefix 10.80.0.0/12 and peered with us-east-1." width="1500" height="960" loading="lazy"></a><figcaption>The whole picture: two data centres, two DX locations, one DX gateway, a Transit Gateway per Region, inspection in the middle.</figcaption></figure>

Read it from left to right. Each data centre has two edge routers. Each router has its own 10 Gbps dedicated connection, and the two data centres use different Direct Connect locations, so no single building, router or fibre takes the hybrid link down. On each connection there's a *transit virtual interface*, which is the kind of VIF that attaches to a Direct Connect gateway that's associated with a Transit Gateway.

The Direct Connect gateway is a global object. It doesn't route traffic between your sites, and it doesn't belong to a Region. It's the place where the VIFs meet and from which Transit Gateways in any Region (up to six per DX gateway) are reached. That's why us-east-2 costs one more association, not four more circuits.

The Transit Gateway lives in a dedicated network account and is shared with the workload accounts through AWS Resource Access Manager. Application teams create a TGW attachment from their VPC. They can't change route tables, and that's the point.

### Why Transit Gateway and not something simpler

There are three common ways to land Direct Connect on VPCs, and the AWS hybrid connectivity guidance walks through all of them:

| Option | Fits when | Why not here |
| --- | --- | --- |
| Private VIF to a virtual private gateway per VPC | A handful of VPCs, one Region | 40 accounts and growing. Every new VPC would mean on-prem routing changes. |
| Private VIF to a DX gateway, many VGWs | Tens of VPCs, no VPC-to-VPC routing, no inspection | No central place to inspect traffic or segment prod from non-prod. |
| **Transit VIF to a DX gateway, Transit Gateway** | Many VPCs, segmentation, inspection, VPN backup on the same hub | This design. |
| AWS Cloud WAN | Many Regions, policy-driven global network | Two Regions today. Worth revisiting at four or more. |

The Transit Gateway also gives the VPN backup and the DX path the same landing point, which is what makes clean failover between them possible.

## Direct Connect: resilient by design

### The resiliency model

AWS publishes three models in its Direct Connect Resiliency Toolkit. *Development and test* is a single location and is exactly what the name says. *High resiliency* is one connection at each of two locations and comes with a 99.9% SLA. *Maximum resiliency* is two connections at each of two locations, on separate devices, and is the one that comes with a 99.99% SLA. The SLA requires that you actually build what the model says, so let the toolkit in the console order the connections for you.

For this company the decision was easy: the requirement is 99.99%, and the business case for the data centre exit runs over these links.

### Sizing the ports

The number that matters is not total capacity. It's what's left when a whole location is gone.

- Four 10 Gbps connections give 40 Gbps when all is well.
- Lose location A and you have 20 Gbps at location B.
- Business peak plus migration is 13 Gbps. That fits, with room to spare for the month-end batch.

Two 10G connections at each location also leave room for growth, and a dedicated connection can be 1, 10, 100 or 400 Gbps if you need more later. If your traffic is well under 1 Gbps, a hosted connection from a Direct Connect partner is cheaper and faster to get, but check what VIF types and speeds your partner supports before you design around them.

### Encryption: MACsec, and when to use IPsec instead

Direct Connect is a private circuit, but it isn't encrypted. The requirement here was encryption for all hybrid traffic, and there are two ways to get it:

- **MACsec** on 10, 100 or 400 Gbps dedicated connections at locations that support it. It encrypts at layer 2 between your router and the AWS device, at line rate. It needs MACsec-capable optics and routers, and you manage the keys (CKN/CAK) on both sides.
- **IPsec VPN over Direct Connect** (private IP VPN on the Transit Gateway). Works with any connection type, end to end into AWS, but each tunnel tops out at 1.25 Gbps, or 5 Gbps with the large bandwidth tunnel option, so you need several tunnels and ECMP to fill a 10G port.

We used MACsec on all four ports and kept the private IP VPN option in the back pocket for the one regulated workload that later asked for end-to-end IPsec.

### The numbers that bite

These are the Direct Connect quotas that real designs run into. Check the current quota page before you build, because two of them changed recently.

| Quota | Value | What it means for you |
| --- | --- | --- |
| Prefixes from on-prem on a private or transit VIF | 100 per BGP session by default for each of IPv4 and IPv6, now raisable to 1,000 with inbound prefix controls (August 2026) | Go over your allocation and the BGP session goes idle. Summarise. |
| Prefixes AWS advertises on a transit VIF | 200 per Transit Gateway, IPv4 and IPv6 combined | Your allowed prefixes list. Summaries again. |
| Transit Gateways per DX gateway | 6 | Plenty for two Regions. A reason to consider Cloud WAN past that. |
| Transit VIFs per dedicated connection | 4 | One per DX gateway you need on that port. |
| VIFs per hosted connection | 1 | A hosted connection carries a single VIF. |

## Routing: BGP, BFD and keeping VPN in its place

<figure class="diagram wide"><a href="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-dx-vpn-routing.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-dx-vpn-routing.svg" alt="Routing and failover detail. Data centre A, ASN 65010, has edge routers A1 and A2; data centre B, ASN 65020, has edge routers B1 and B2; a 2 by 10G interconnect runs iBGP between all four routers. Each router has one transit VIF: VIFs 1 and 2 at location A and VIFs 3 and 4 at location B, each with its own BGP session, BFD at 300 milliseconds times 3 for 0.9 second detection, and MACsec on the port. All four land on the Direct Connect gateway, which feeds the Transit Gateway in us-east-1. A Site-to-Site VPN with four tunnels and ECMP comes from both data centre firewalls over the internet into the same Transit Gateway, advertising the same two prefixes as DX with AS_PATH prepended three times. The onprem route table shows 10.0.0.0/11, 10.32.0.0/11 and 10.0.0.0/10 via the DX gateway with the VPN routes hidden; if all DX fails the same three prefixes reappear via VPN. Panel one, AWS to on-prem: data centre A routers send 10.0.0.0/11 with community 7224:7300, high, on VIFs 1 and 2; data centre B routers send 10.32.0.0/11 with 7224:7300 on VIFs 3 and 4; every router also sends the other site's /11 and the 10.0.0.0/10 summary with 7224:7100, low. AWS therefore uses the location next to the data, with ECMP across its two VIFs, and moves to the other location and the interconnect only when the first is gone; AWS evaluates these communities before AS_PATH length. Panel two, on-prem to AWS: AWS advertises only the allowed prefixes 10.64.0.0/12 and 10.80.0.0/12 on every VIF; the VPN advertises the same two because the onprem Transit Gateway route table holds only static summaries; edge routers set local preference 200 on DX-learned routes and 100 on VPN-learned routes; on-prem advertises six prefixes per VIF against a default limit of 100, which drops the BGP session if exceeded and can be raised to 1,000 with prefix controls. Panel three, Transit Gateway route priority for the same destination: the most specific prefix first, then static routes, prefix-list referenced routes, VPC-propagated, Direct Connect gateway-propagated, Connect-propagated, and finally VPN over private DX and Site-to-Site VPN routes. The trap: a 10.0.12.0/22 learned over VPN beats 10.0.0.0/11 learned over DX because longest match comes first, so filter the VPN to the same summaries and alarm on any VPN next hop while DX is up. A failure table: one connection or router is detected by BFD in about 0.9 seconds and traffic moves to the other VIF at the same location, leaving 30 Gbps; a whole DX location is detected by BFD and traffic moves to the other location's VIFs and then the interconnect, leaving 20 Gbps; all four DX connections fail, BFD then BGP withdraw, and the VPN carries traffic with about 4 Gbps limited by the internet circuits; a link with BFD missing on the router is only detected by the 90 second BGP hold timer, and traffic is black-holed until then." width="1500" height="920" loading="lazy"></a><figcaption>Communities steer AWS to the right location, local preference steers on-prem to DX, and BFD makes failover sub-second.</figcaption></figure>

### AWS to on-prem: local-preference communities

When AWS has several paths back to your network for the same prefix, you tell it which one to use with BGP communities on the routes you advertise. Direct Connect supports three local-preference communities on private and transit VIFs: `7224:7100` (low), `7224:7200` (medium) and `7224:7300` (high). AWS evaluates them before AS_PATH length, which makes them the reliable lever. AS_PATH prepending also works, but only between paths that have the same local preference.

The pattern here:

- Data centre A's routers advertise `10.0.0.0/11` (data centre A's own range) with `7224:7300` and data centre B's `/11` plus the `10.0.0.0/10` summary with `7224:7100`.
- Data centre B's routers do the mirror image.
- Within a location the two VIFs carry identical routes, so AWS load-shares across them.

The result is that traffic for a New Jersey server enters at location A, traffic for Chicago enters at location B, and if location A disappears, New Jersey traffic arrives at Chicago and crosses the data centre interconnect. That interconnect is part of the hybrid design whether you like it or not, so size it accordingly.

### On-prem to AWS: prefer DX, and only summaries

AWS advertises to you only what you put in the *allowed prefixes* list on the DX gateway association. Here that's `10.64.0.0/12` for us-east-1 and `10.80.0.0/12` for us-east-2, two lines that cover every VPC we will ever create in those Regions. Without a list, AWS advertises the attached VPC CIDRs, and you start chasing new prefixes every time a team creates a VPC.

On the edge routers:

- Local preference 200 on routes learned over DX, 100 on routes learned over VPN.
- iBGP between all four routers, so data centre B can use data centre A's DX if both of its own connections fail.
- An outbound prefix list on every DX session that allows only the approved summaries. This is what stops incident 2 below.

### BFD: the difference between 0.9 seconds and 90

Direct Connect supports asynchronous Bidirectional Forwarding Detection on every VIF. AWS runs it with a 300 ms interval and a multiplier of 3, so a dead path is detected in about 0.9 seconds, but only if your router runs BFD too. If it doesn't, the only failure detector is the BGP hold timer, which is 90 seconds by default. For 90 seconds AWS keeps sending traffic into a dead link. Turn BFD on, and test it by actually pulling a link in a game day.

### Keeping the VPN as a backup

The VPN is two Site-to-Site VPN connections, one from each data centre firewall, four tunnels in total, with dynamic BGP routing so the Transit Gateway can use ECMP across them. ECMP only works with dynamic routing, and only between attachments of the same type. Each standard tunnel carries up to 1.25 Gbps, but the real cap is the two 2 Gbps internet circuits, so plan for about 4 Gbps in VPN mode.

Three things keep it a backup:

1. **Inside the Transit Gateway, DX wins for the same prefix.** When two attachments propagate the same CIDR, the TGW prefers the Direct Connect gateway over Connect, and both over Site-to-Site VPN. That ordering only applies to *identical* prefixes. Longest match comes first.
2. **So the VPN advertises exactly the same prefixes as DX.** The onprem routers send the same three summaries over the VPN. A single more-specific route over VPN pulls that range off DX.
3. **And the VPN gets the same summaries from AWS.** A VPN on a Transit Gateway advertises the routes in its TGW route table. If that table had VPC-propagated routes, the VPN would advertise `/16`s and `/21`s that beat the DX `/12` on your routers regardless of local preference. Here the `onprem` route table holds only two static summaries, so DX and VPN advertise identical routes in both directions.

### Transit Gateway route tables and segmentation

| Route table | Associated with | Contents |
| --- | --- | --- |
| `onprem` | DX gateway attachment, both VPN attachments | Static `10.64.0.0/12` and `10.80.0.0/12` to the inspection VPC. Static `10.74.0.0/16` (migration) straight to the migration VPC. |
| `prod` | Prod VPCs | `10.0.0.0/10` to inspection. Shared services propagated. |
| `nonprod` | Non-prod VPCs | `10.0.0.0/10` to inspection. Shared services propagated. Nothing from prod. |
| `inspection` | Inspection VPC | Propagated from every VPC, DX gateway and VPN. |
| `shared` | Shared services VPC | Propagated from everything, so DNS works for everyone. |
| `migration` | Migration landing VPC | DX gateway and prod. Deleted when data centre A closes. |

The inspection VPC runs AWS Network Firewall with the TGW attachment in *appliance mode*, which keeps both directions of a flow on the same firewall endpoint even when source and destination are in different Availability Zones. Forget appliance mode and you get asymmetric routing and dropped sessions that look random.

The migration table is a deliberate exception. Disk replication and file copies move several hundred terabytes over a year, and they're between known, controlled endpoints. Sending them through the firewall would add about $0.065 per GB of processing for no security gain. Instead, the migration subnets only accept replication ports from the agents' address ranges, and the whole table is deleted when the project ends.

## Hybrid DNS with Route 53 Resolver

<figure class="diagram wide"><a href="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-dns.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-dns.svg" alt="Hybrid DNS design. On-premises, in both data centres: users and apps, Active Directory DNS at site A on 10.1.0.10 and at site B on 10.33.0.10 serving corp.example, and a backup server that writes to S3. A shared services account holds a shared services VPC 10.72.0.0/16 across three Availability Zones with a Route 53 Resolver inbound endpoint on 10.72.1.10, 10.72.2.10 and 10.72.3.10, an outbound endpoint with three network interfaces, one per AZ, the Route 53 Resolver at the VPC plus two address, DNS Firewall with malware and allow lists, query logging to the Log Archive account, and interface endpoints for S3, STS and Secrets Manager. A network account owns the DNS configuration: a Route 53 Profile named corp-dns, shared with the organisation through RAM, and a private hosted zone aws.corp.example; the profile bundles the corp.example forwarding rule, the private hosted zone and DNS Firewall rule groups, and is associated with every VPC. In a prod account, one of about forty, the orders VPC 10.64.8.0/21 contains orders-api on EC2 and the VPC Resolver; the profile is associated at VPC creation by account vending, so rules, the zone and DNS Firewall arrive automatically. Flow 1, AWS to on-prem: orders-api asks the VPC Resolver for erp.corp.example, the forwarding rule matches, and Resolver sends the query out of the outbound endpoint over Direct Connect to the AD DNS servers. Flow 2, on-prem to AWS: a user asks AD DNS for orders.aws.corp.example, AD DNS has a conditional forwarder for aws.corp.example pointing at the three inbound endpoint IPs, and Resolver answers from the private hosted zone after checking DNS Firewall; never forward the root or corp.example back the other way, which makes a loop. Flow 3, PrivateLink from on-prem: AD DNS forwards s3.us-east-1.amazonaws.com to the inbound endpoint, so it resolves to the interface endpoint's private IPs and backups travel over Direct Connect instead of the internet. A note on sizing: start with one IP per AZ, watch the endpoint query metrics and add IPs before peak; restrictive security groups turn on connection tracking, which lowers per-IP capacity significantly." width="1500" height="800" loading="lazy"></a><figcaption>Two endpoints in one shared VPC, one Route 53 Profile for every VPC, and conditional forwarders on-prem for exactly the names that live in AWS.</figcaption></figure>

Most hybrid outages I've been called into weren't routing. They were DNS. The design is simple, and the discipline is in what you *don't* forward.

- **Outbound** (AWS to on-prem). A Resolver *forwarding rule* for `corp.example` sends queries to both AD DNS servers through an outbound endpoint in the shared services VPC.
- **Inbound** (on-prem to AWS). AD DNS has a conditional forwarder for `aws.corp.example` that points at the inbound endpoint's three IPs, one per Availability Zone. Resolver answers from the private hosted zone.
- **Distribution.** A Route 53 Profile in the network account bundles the forwarding rule, the private hosted zone and the DNS Firewall rule groups. It's shared to the organisation with RAM and associated with every new VPC by the account vending pipeline. Before Profiles existed you shared rules with RAM and associated zones VPC by VPC, which is exactly the sort of thing that's forgotten for the fortieth account.
- **PrivateLink names.** On-prem systems that should use an interface endpoint, such as the backup server writing to S3, need that service's name forwarded to the inbound endpoint. Forward just those names, not all of `amazonaws.com`.
- **Guardrails.** DNS Firewall blocks known-bad domains for every VPC, and Resolver query logs go to the Log Archive account.

Two rules prevent the classic failures. Never forward a zone in both directions, because a query that bounces between Resolver and AD DNS ends as a timeout, not an error. And size the endpoints like anything else that sits on a critical path: watch their query metrics, add IP addresses before peak, and keep their security groups simple, because connection tracking lowers how many queries each address can handle.

## The data centre exit

<figure class="diagram wide"><a href="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-migration-outposts.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-migration-outposts.svg" alt="Data centre exit and Outposts. Data centre A, which is closing, has a VMware estate of 900 VMs with 310 TB of disks, each with an MGN agent; file shares of 420 TB read by two DataSync agent VMs; and Oracle 22 TB and SQL Server 16 TB databases that DMS reads directly without an agent. All three flows cross Direct Connect, four 10G connections with migration traffic capped at 8 Gbps by QoS on the edge routers, into us-east-1. In a migration landing account, AWS Application Migration Service does block-level continuous replication on private IPs, with a test launch then cutover per wave, to rehosted EC2 in the prod account; DataSync through a VPC endpoint runs incremental syncs nightly and a final sync at cutover into FSx for Windows File Server and S3 archive tiers; DMS replication instances do a full load plus change data capture, cutting over when lag is under five seconds and row counts match, into RDS for Oracle and RDS for SQL Server. A note says rehost first and modernise after the data centre is closed, because the deadline is the lease. An 18-month plan, with the lease ending in month 18: foundations for DX, Transit Gateway, DNS and accounts in months 0 to 3, alongside discovery and wave planning; a pilot wave of 40 VMs in month 3 to 4; waves 1 to 8 of about 110 VMs each from month 4 to 13; file shares, 420 TB with DataSync, months 6 to 9; databases with DMS full load and CDC, months 8 to 14; re-homing DX location A to data centre B, months 14 to 16; and decommissioning plus buffer, months 15 to 18. A bandwidth check: 8 Gbps is 1 GB per second, about 86 TB a day at full rate, about 50 TB a day at a realistic 60 percent, so 420 TB of files is about 9 days of transfer, planned as 3 weeks with business-hours throttling. On the right, region us-east-2, the Outposts parent, holds a Transit Gateway; the control plane, AMIs, snapshots and monitoring live in the Region. At the plant in Ohio, an Outposts rack of 42U runs MES on EC2 with N plus 1 capacity and S3 on Outposts, with a local gateway to the plant LAN and the line controllers. The service link runs over the plant's DX, redundant, at least 500 Mbps per rack, at most 175 ms round trip. MES must answer the line in under 5 ms; if the service link drops, plan for running-but-unmanaged: size for N+1 locally and keep line data on S3 on Outposts." width="1500" height="920" loading="lazy"></a><figcaption>Three migration paths over the same DX, an 18-month plan that ends before the lease does, and the one Outpost.</figcaption></figure>

### The tools, and why each

- **AWS Application Migration Service (MGN)** for the 900 VMs. It replicates block-level changes continuously from an agent on each VM into a staging area in the migration landing account, then launches test instances and, at cutover, the real ones. Turn on private IP replication so it uses DX, not the internet.
- **AWS DataSync** for the 420 TB of file shares, through a VPC endpoint so the data stays on DX. Initial copy, then nightly incremental syncs, then a final sync in the cutover window. Targets are FSx for Windows File Server for anything still mapped as a drive, and S3 for the archive shares nobody has opened in three years (most of them, once you look).
- **AWS Database Migration Service (DMS)** for the databases. Full load, then change data capture until cutover. Here they move to RDS for Oracle and RDS for SQL Server first; engine changes come after the exit, not during it.

The rule that saved this project: **rehost first, modernise after**. The deadline is a lease, and every wave that turns into a re-architecture project puts the date at risk. Teams that want EKS can have it in month 20.

### The bandwidth maths

Work this out before you promise a date:

| Data | Size | At 8 Gbps, 60% efficiency (about 50 TB/day) | Planned |
| --- | --- | --- | --- |
| File shares | 420 TB | About 9 days | 3 weeks, throttled to 2 Gbps in business hours |
| VM disks (initial replication) | 310 TB | About 6 days in total | Spread over 9 waves, so about 35 TB a wave |
| Databases | 38 TB | Under 1 day for full load | Full load at a weekend, then CDC for weeks |

The migration traffic is capped at 8 Gbps by QoS on the edge routers, which is what keeps it from hurting business traffic, and what keeps it inside one location's capacity if the other goes down. Data transfer *into* AWS over DX is free, but every gigabyte crossing the Transit Gateway pays data processing (about $0.02 per GB), so 770 TB costs roughly $15,000 in TGW processing over the project. That's in the business case, not a surprise in month 7.

### Cutover weekend, an example

The order-management wave was the one everyone worried about: 14 VMs, a 3 TB SQL Server database, and a file share used by the warehouses.

- **T minus 48 h.** DNS TTLs for the app's names lowered from 3600 s to 60 s. DMS CDC lag under 2 s for a week.
- **Friday 22:00.** Change freeze. MGN test instances already passed UAT the previous weekend.
- **Saturday 01:00.** App stopped on-prem. Final DataSync run: 41 GB of changes, 6 minutes.
- **01:20.** DMS lag at 0, row counts and checksums on 12 key tables match. Source made read-only.
- **01:35.** MGN cutover launched. Instances healthy at 01:52.
- **02:10.** DNS records switched to the new addresses, in the Route 53 private zone and in AD DNS for the legacy name.
- **02:40.** Smoke tests and a real warehouse pick confirmed. Go decision at 03:00.
- **Rollback plan, unused:** point DNS back, make the source writable. Valid until Monday 06:00, after which reverse sync would be needed.

### When DX location A has nothing left to connect

One detail that is easy to miss: data centre A's two DX connections terminate on data centre A's routers. When the building closes, those connections have nowhere to go, and you're down to one location. The plan re-homes location A's cross-connects to data centre B over a carrier circuit in months 14 to 16, so the maximum resiliency model survives the exit. Order that circuit early; carrier lead times are measured in months.

## Outposts: when it's worth it

The largest plant's manufacturing execution system talks to line controllers and has to answer in under 5 ms. us-east-2 is a few hundred kilometres away. The options:

| Option | Latency to the line | Fits when | Watch out for |
| --- | --- | --- | --- |
| Region over DX | 5 to 10 ms plus jitter | Most plant systems: planning, quality, dashboards | Doesn't meet 5 ms, and a WAN outage stops the line. |
| AWS Local Zone | Low, if one is near | A metro Local Zone close to the site | No Local Zone near this plant. |
| **AWS Outposts rack** | Sub-millisecond on the plant LAN | Latency, local data processing or residency, and the same APIs as the Region | You own the floor space, power and network. It needs a healthy service link. |
| Outposts servers (1U/2U) | Sub-millisecond | Smaller sites, a few instances | Fewer services, no built-in redundancy across servers unless you buy two. |
| Keep it on-prem | Sub-millisecond | Hardware with years of life left | Separate tooling, separate skills. |

The plant got an Outposts rack, anchored to us-east-2, running the MES on EC2 with N+1 capacity, with line data landing in S3 on Outposts and a *local gateway* connecting the Outpost to the plant LAN. The service link back to the Region goes over the plant's Direct Connect, and AWS requires it to be redundant, at least 500 Mbps per compute rack, with no more than 175 ms round trip.

Treat the service link like the umbilical cord it is. The control plane lives in the Region. Plan for the link being down as *running but unmanaged*: what's running keeps running, but you can't count on launching, resizing or changing anything until it's back. So keep enough spare capacity on the rack to survive a host failure without the Region, and test exactly that.

## Five incidents, and what fixed them

### 1. A backhoe at location A, during month-end close

**What happened.** At 16:42 on the last working day of the month, a construction crew cut a fibre bundle outside DX location A. Both connections at that location went down within a second of each other.

**What the signals showed.** BFD on all four routers was configured during the pilot, so both sessions at location A dropped in about 0.9 seconds. AWS moved New Jersey-bound traffic to location B (the `7224:7100` paths), and from there across the data centre interconnect. The month-end batch, running at 4.1 Gbps, slowed by about 8% because of the extra 18 ms round trip through Chicago. No job failed. The incident ticket was opened by the carrier's alarm, not by a user.

**What made it a non-event.** Two locations, BFD on both ends, and an interconnect sized for a location failure. The game day three months earlier had found the one router where BFD wasn't on.

### 2. 112 prefixes, and every BGP session goes idle

**What happened.** A network engineer onboarding a new plant redistributed its routes into BGP without summarising. The edge routers started advertising 112 prefixes on every transit VIF. All four sessions went idle within a minute, because each was over the 100-prefix allocation, and traffic fell back to VPN.

**What the signals showed.** The VPN, capped at 4 Gbps by the internet circuits, was asked to carry 9 Gbps of business and migration traffic. Packet loss on the VPN peaked at 30%. DMS tasks for the next wave fell 6 hours behind.

**What fixed it.**

- An outbound prefix list on every DX session that only allows the approved summaries, so an internal change can't leak to AWS.
- Alarms when a VIF's BGP session leaves *established*, and when the number of advertised prefixes passes 80% of the allocation.
- The VIFs' inbound prefix allocation raised to 300 with Direct Connect's new prefix controls, as headroom, not as a plan.
- QoS on the VPN path so that migration traffic is dropped first if it ever carries everything again.

### 3. Traffic took the VPN while DX was perfectly healthy

**What happened.** Users of a reporting app in us-east-1 complained it was slow. Round-trip time had gone from 4 ms to 38 ms, and the internet circuit graphs were showing traffic that should have been on DX.

**What the signals showed.** Someone had added a static route for `10.0.12.0/22` on the VPN connection while troubleshooting, months earlier. In the TGW `onprem` route table, the `/22` over VPN beat the `/11` over DX, because longest match comes before attachment type.

**What fixed it.** The static route was removed, VPN connections were moved to BGP only, and a scheduled check now alerts if any route in the `onprem` table has a VPN next hop while the DX attachment is up. A route that disappears from your attention is a route that will hurt you later.

### 4. DNS timeouts at 02:00 every night

**What happened.** Every night between 02:00 and 02:30, on-prem backup jobs failed with name-resolution errors for S3.

**What the signals showed.** An old setting on AD DNS forwarded all of `amazonaws.com` to the inbound endpoint. At 02:00, 600 backup clients started at once, and each upload resolved several names. The inbound endpoint's two IPs, behind a security group with tight rules that forced connection tracking, ran out of headroom.

**What fixed it.** Forwarding only the specific service names that have interface endpoints, adding a third IP in a third Availability Zone, simplifying the security group so connection tracking isn't needed, alarming on the endpoint query metrics, and staggering backup start times across 30 minutes.

### 5. "We'll copy the file shares over the weekend"

**What happened.** The original plan said 420 TB of file shares would move "over a weekend in month 6". Someone did the maths in month 5.

**What the signals showed.** Even at 8 Gbps and perfect efficiency, 420 TB is more than five days of transfer. At a realistic 60%, closer to nine.

**What fixed it.** DataSync started three weeks before cutover, throttled to 2 Gbps in business hours and 8 Gbps at night and weekends, with nightly incremental syncs. The cutover itself only had to move the last day of changes. The broader lesson went into the wave plan: every data move gets a bandwidth line item before it gets a date.

## Mapping to the Well-Architected pillars

The Hybrid Networking Lens of the AWS Well-Architected Framework applies the six pillars to exactly this problem. This is how the design lines up:

| Pillar | Well-Architected guidance | How this design answers it |
| --- | --- | --- |
| Reliability | REL02-BP02, provision redundant connectivity between private networks in the cloud and on-premises environments | Four DX connections at two locations (maximum resiliency), VPN as a third path, BFD for sub-second detection, failover tested quarterly. |
| Reliability | REL02-BP04 and BP05, prefer hub-and-spoke, enforce non-overlapping private IP ranges | Transit Gateway hub per Region. On-prem `10.0.0.0/10`, AWS `10.64.0.0/12` and `10.80.0.0/12`, allocated from IPAM. |
| Reliability | Hybrid Networking Lens: provision sufficient network capacity | Ports sized for the loss of a whole location: 13 Gbps of demand against 20 Gbps left. |
| Security | SEC05, protect your networks: layers, traffic control, inspection | TGW route tables separate prod and non-prod. Every on-prem flow goes through Network Firewall. DNS Firewall on every VPC. |
| Security | SEC09, protect data in transit | MACsec on all four DX ports. IPsec over DX available per workload. |
| Operational excellence | Hybrid Networking Lens: monitor hybrid networking components | Alarms on BGP state, prefix counts, VPN next hops, Resolver endpoint metrics and DX port utilisation. Quarterly game days. |
| Performance efficiency | PERF04, select and configure networking resources | Location-aware routing with communities keeps traffic on the shortest path. Outposts where latency must be sub-5 ms. |
| Cost optimisation | COST08, plan for data transfer | DX data transfer out at about a quarter of internet rates. Migration traffic skips firewall processing. TGW processing for the migration is budgeted up front. |
| Sustainability | Right-size and retire | Closing a data centre and rehosting onto right-sized instances, with an explicit decommission phase so idle hardware is switched off, not left running "just in case". |

## What it costs

Approximate us-east-1 list prices at the time of writing, for steady state after the migration. Check the AWS pricing pages and the Pricing Calculator for your own numbers; carrier and colocation cross-connect fees aren't included.

| Item | Quantity | Approx. per month |
| --- | --- | --- |
| Direct Connect 10G dedicated ports | 4 x 730 h at about $2.25/h | $6,570 |
| DX data transfer out to on-prem | 40 TB at about $0.02/GB | $820 |
| Transit Gateway attachments | About 13 at $0.05/h | $475 |
| Transit Gateway data processing | 80 TB at $0.02/GB | $1,640 |
| Network Firewall | 3 endpoints, plus 80 TB processed | About $6,200 |
| Site-to-Site VPN | 2 connections at $0.05/h | $73 |
| Route 53 Resolver endpoints | 2 endpoints x 3 IPs at $0.125/h, plus queries | About $630 |
| **Total** | | **About $16,400** |

Two things stand out. The inspection firewall costs as much as the circuits, so be deliberate about what crosses it. And the four 10G ports are a third of the bill; a company that doesn't need 99.99% could run the high resiliency model with two connections and save half of that line.

## Production-readiness checklist

- Two DX locations, two connections each, ordered through the Resiliency Toolkit
- MACsec configured and verified on every port, keys rotated on a schedule
- Transit VIFs with BFD on both ends, tested by pulling a link
- Local-preference communities set per site, AS_PATH prepending on VPN only
- Allowed prefixes on every DX gateway association set to Region summaries
- Outbound prefix lists on every DX and VPN session; alarms on prefix count and BGP state
- VPN with dynamic routing, same prefixes as DX, and an alarm on VPN next hops while DX is up
- `onprem` TGW route table with static summaries only; appliance mode on the inspection attachment
- Resolver inbound and outbound endpoints in three AZs, a Route 53 Profile associated by account vending
- Conditional forwarders on-prem for `aws.corp.example` and specific PrivateLink service names only
- A bandwidth line item for every migration data move, with QoS capping migration traffic
- A plan for what happens to a closing site's DX connections
- Outposts sized N+1 and tested with the service link down
- Quarterly game day covering location loss, total DX loss and DNS endpoint loss
- All of the above in infrastructure as code, reviewed in pull requests

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the names, ASNs and CIDRs to match your network.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/aws-hybrid-direct-connect-transit-gateway.drawio)
- [Hybrid reference architecture](/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-reference.drawio)
- [Direct Connect, VPN backup and routing](/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-dx-vpn-routing.drawio)
- [Hybrid DNS with Route 53 Resolver](/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-dns.drawio)
- [Data centre exit and Outposts](/assets/diagrams/aws-hybrid-direct-connect-transit-gateway/hybrid-migration-outposts.drawio)

Company details, ASNs, CIDRs, volumes and prices are examples. Quotas and prices change, so check the current AWS documentation for your Regions before you build.

## References

- [Hybrid Networking Lens, AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/hybrid-networking-lens/hybrid-networking-lens.html)
- [REL02: plan your network topology (Reliability pillar)](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/plan-your-network-topology.html)
- [AWS Direct Connect Resiliency Toolkit](https://docs.aws.amazon.com/directconnect/latest/UserGuide/resiliency_toolkit.html)
- [Direct Connect gateways](https://docs.aws.amazon.com/directconnect/latest/UserGuide/direct-connect-gateways-intro.html)
- [Direct Connect routing policies and BGP communities](https://docs.aws.amazon.com/directconnect/latest/UserGuide/routing-and-bgp.html)
- [Direct Connect quotas](https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html)
- [Direct Connect inbound prefix controls (August 2026)](https://aws.amazon.com/about-aws/whats-new/2026/08/aws-direct-connect-new-prefix-controls/)
- [MACsec on Direct Connect](https://docs.aws.amazon.com/directconnect/latest/UserGuide/MACsec.html)
- [How AWS Transit Gateway works, including route evaluation order](https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html)
- [Transit Gateway quotas](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-quotas.html)
- [Site-to-Site VPN quotas](https://docs.aws.amazon.com/vpn/latest/s2svpn/vpn-limits.html)
- [Site-to-Site VPN 5 Gbps tunnels](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-site-to-site-vpn-5-gbps-bandwidth-tunnels/)
- [Hybrid Connectivity whitepaper](https://docs.aws.amazon.com/whitepapers/latest/hybrid-connectivity/hybrid-connectivity.html)
- [Route 53 Resolver](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html)
- [Route 53 Resolver endpoint scaling](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/best-practices-resolver-endpoint-scaling.html)
- [Route 53 Profiles](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/profiles.html)
- [AWS Application Migration Service](https://docs.aws.amazon.com/mgn/latest/ug/what-is-application-migration-service.html)
- [AWS DataSync](https://docs.aws.amazon.com/datasync/latest/userguide/what-is-datasync.html)
- [AWS Database Migration Service](https://docs.aws.amazon.com/dms/latest/userguide/Welcome.html)
- [AWS Outposts service link](https://docs.aws.amazon.com/outposts/latest/userguide/service-links.html)
- [AWS Outposts high availability design](https://docs.aws.amazon.com/whitepapers/latest/aws-outposts-high-availability-design/aws-outposts-high-availability-design.html)
- [AWS Network Firewall](https://docs.aws.amazon.com/network-firewall/latest/developerguide/what-is-aws-network-firewall.html)
