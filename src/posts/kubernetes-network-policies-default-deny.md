---
title: "In a default Kubernetes cluster, any pod can reach your database"
description: "Kubernetes pod networking is flat by default. How NetworkPolicies lock it down, a default-deny pattern that's easy to reason about, and the selector trap everyone hits once."
date: 2026-11-14T04:00:00Z
category: Kubernetes
coverLabel: "Flat by default.\nDeny by design."
coverCode: "policyTypes: [Ingress]"
---
Out of the box, a Kubernetes pod network is flat. Every pod can open a connection to every other pod, in every namespace. That includes your database, and it includes whatever compromised pod an attacker just landed in.

NetworkPolicies fix this. They're a firewall for pods, written with labels instead of IP addresses, and they're one of the cheapest security wins in Kubernetes.

<figure class="diagram"><img src="/assets/diagrams/k8s-network-policies.gif" alt="Animation of traffic between frontend, backend and db pods before and after NetworkPolicies, where only frontend to backend and backend to db remain allowed." width="720" height="900" loading="lazy"><figcaption>Before: every path works. After: only the ones you asked for.</figcaption></figure>

## Before and after

**Before:** internet to `frontend` to `backend` to `db` works. So do `frontend` straight to `db`, and a pod in some other namespace straight to `db`. Nobody asked for those last two.

**After** two policies, only the three paths you need still work. Everything else is dropped at the pod.

## The two policies

Only `backend` may talk to `db`, and only on Postgres:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-from-backend
  namespace: shop
spec:
  podSelector:
    matchLabels: { app: db }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: backend }
      ports:
        - port: 5432
```

The `backend` policy looks the same, allowing `app: frontend` on port 8080.

## Start with default deny

Writing allow rules pod by pod gets confusing fast. A cleaner pattern is to deny everything in a namespace first, then add exactly what you need:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: shop
spec:
  podSelector: {}
  policyTypes: [Ingress]
```

An empty `podSelector` selects every pod in the namespace. With no `ingress` rules, nothing gets in. Now every allowed path in the namespace is one you wrote down on purpose, which makes reviews much easier.

## Things that trip people up

- **Your CNI has to enforce them.** Calico, Cilium, the AWS VPC CNI's network policy agent, Azure's and GKE's built-in options all do. Some basic setups accept the objects and silently ignore them. Test with a pod that *shouldn't* connect.
- **Once any policy selects a pod, the default flips.** For that direction (ingress or egress), everything not explicitly allowed is denied.
- **Egress lockdown breaks DNS.** If you add `Egress` to `policyTypes`, allow UDP and TCP port 53 to `kube-dns`, or nothing will resolve and every error will look like a networking bug.
- **The AND vs OR trap.** This is the one that gets everyone once:

```yaml
# AND: pods labelled app=backend IN namespaces labelled team=shop
- from:
    - namespaceSelector: { matchLabels: { team: shop } }
      podSelector: { matchLabels: { app: backend } }

# OR: ANY pod in team=shop namespaces, OR app=backend pods in this namespace
- from:
    - namespaceSelector: { matchLabels: { team: shop } }
    - podSelector: { matchLabels: { app: backend } }
```

One dash makes the difference. The second version is much wider than it looks.

## Test it

```sh
# Should print BLOCKED once the policies are applied
kubectl run probe --rm -it --image=busybox -n shop -l app=frontend -- \
  sh -c 'nc -w 3 db 5432 </dev/null && echo CONNECTED || echo BLOCKED'
```

If that connection still succeeds, check whether your CNI enforces policies before you check the YAML.

## References

- [Kubernetes: Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Kubernetes: Declare a network policy](https://kubernetes.io/docs/tasks/administer-cluster/declare-network-policy/)
