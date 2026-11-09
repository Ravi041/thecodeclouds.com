---
title: "From the internet to an EKS pod: every checkpoint on the way"
description: "Follow one HTTPS request through an Internet Gateway, NACLs, security groups, an ALB, Istio and a NetworkPolicy, and see where each kind of bad traffic gets stopped."
date: 2026-11-10T04:00:00Z
category: Cloud Networking
coverLabel: "Seven checkpoints\nto one pod."
coverCode: "IGW → NACL → SG → ALB → pod"
coverLogos: "aws, kubernetes"
coverImage: /assets/images/covers/aws-eks-request-path.jpg
coverImageAlt: "Cloud Networking cover reading 'Seven checkpoints to one pod.', beside a frame of the article's animated diagram."
---
"The pod is running but I can't reach it" is one of those problems where everything looks fine on its own. The pod is healthy, the Service exists, the load balancer is green. Somewhere between the internet and the container, one of half a dozen layers is quietly dropping the packet.

It helps to walk the whole path once, slowly. Here is a single HTTPS request reaching an app on Amazon EKS, and every place that can say no.

<figure class="diagram"><img src="/assets/diagrams/aws-eks-traffic.gif" alt="Animation of an HTTPS request travelling from the internet through an Internet Gateway, public subnet, ALB, private subnet, Istio ingress gateway and into frontend and api pods on EKS, with blocked traffic shown at the NACL, security group and NetworkPolicy." width="720" height="900" loading="lazy"><figcaption>One request in, one reply out, and three kinds of traffic that never make it.</figcaption></figure>

## The building blocks first

- **VPC:** your private network in one region, here `10.0.0.0/16`, spread across Availability Zones.
- **Subnet:** a slice of the VPC that lives in exactly one AZ.
- **Route table:** decides where packets go next. This is the *only* thing that makes a subnet public or private.
- **Public subnet:** its route table sends `0.0.0.0/0` to an Internet Gateway.
- **Private subnet:** its default route points at a NAT Gateway. It can call out, but nothing can call in.
- **NACL:** a firewall on the subnet. Stateless, numbered rules, and it can both allow *and* deny.
- **Security group:** a firewall on the network interface. Stateful, allow-only, and it can reference other security groups ("only from `sg-alb`").

## The path of one request

1. **Internet Gateway.** The request enters the VPC.
2. **Public subnet NACL.** Rule 100 allows 443 in.
3. **ALB security group.** Allows 443 from anywhere. TLS terminates at the ALB.
4. **Into the private subnet.** The ALB forwards to a node. The private subnet's NACL checks it, then the node's security group, which only accepts traffic from `sg-alb`.
5. **Istio ingress gateway.** It matches the host and path from the `Gateway` and `VirtualService` and sends the request to the `frontend` pods.
6. **Pod to pod.** `frontend` calls `api`. That hop goes Envoy sidecar to Envoy sidecar over mutual TLS, and a Kubernetes `NetworkPolicy` on `api` only accepts traffic from `app=frontend`.
7. **The reply** goes back the same way.

## What gets blocked, and where

- **A scanner from `203.0.113.0/24`** hits NACL rule 90, which denies that range. A security group couldn't do this. Security groups have no deny rules.
- **SSH on port 22** reaches the ALB, but `sg-alb` has no rule for it, so it's dropped.
- **`frontend` trying to reach `db` directly** is stopped at the pod by NetworkPolicy, even though both are inside the same VPC and the same cluster.

On the way out, a pod in a private subnet that calls an external API goes through the NAT Gateway, which swaps its private IP for the gateway's Elastic IP.

## Where people get bitten

- **NACLs are stateless.** Allow 443 inbound but forget outbound ephemeral ports (1024 to 65535), and the replies die silently. Security groups track connections. NACLs don't.
- **Pods eat VPC addresses.** With the Amazon VPC CNI, every pod gets a real IP from your subnet. A `/24` private subnet runs out much faster than you'd think. Size them generously, or look at prefix delegation.
- **One NAT Gateway per AZ.** A single shared NAT is a cross-AZ data charge on every call and a single point of failure.
- **NetworkPolicy needs an enforcer.** The VPC CNI's network policy agent, Calico or Cilium. Without one, your policies are accepted and silently ignored.
- **mTLS and NetworkPolicy aren't either/or.** Istio checks *who* is calling at L7. NetworkPolicy checks IPs and ports at L3/L4. Use both.

## A quick check when traffic doesn't arrive

Work from the outside in:

```sh
# Is the ALB target healthy?
aws elbv2 describe-target-health --target-group-arn <tg-arn>

# What does the node's security group actually allow?
aws ec2 describe-security-groups --group-ids <sg-node> \
  --query 'SecurityGroups[0].IpPermissions'

# Does the Service have endpoints?
kubectl get endpointslices -l kubernetes.io/service-name=frontend

# Which NetworkPolicies select the target pod?
kubectl get networkpolicy -n <namespace>
```

If the target group is unhealthy, look at security groups and NACLs. If it's healthy but requests fail, look at Istio routing and NetworkPolicy.

## References

- [Amazon VPC: Network ACLs](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html)
- [Amazon VPC: Security groups](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html)
- [Amazon EKS: Pod networking with the VPC CNI](https://docs.aws.amazon.com/eks/latest/userguide/managing-vpc-cni.html)
- [Amazon EKS: Network policies](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html)
- [Istio: Mutual TLS](https://istio.io/latest/docs/concepts/security/#mutual-tls-authentication)
