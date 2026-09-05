---
title: "Your pod is stuck. Here's where to look first."
description: "A calm, practical checklist for debugging Kubernetes pods—before you reach for another restart."
date: 2026-09-05T08:00:00Z
category: Kubernetes
coverLabel: "Read the events."
coverCode: "$ kubectl describe pod"
coverKind: pod-debug
coverImage: /assets/images/kubernetes-troubleshooting.jpg
coverImageAlt: "Blue and teal computing blocks connected around a diagnostic magnifying glass."
coverCredit: "AI-generated editorial illustration."
---
When a pod will not start, a restart feels productive. But it can also make the original evidence harder to find. Begin by asking a smaller question: **what is Kubernetes waiting for?**

This is a read-only troubleshooting checklist. Use your own namespace and pod name, and make sure your current context is the cluster you intend to inspect.

## 1. Establish the scope

```sh
kubectl config current-context
kubectl get pods -n YOUR_NAMESPACE -o wide
kubectl describe pod YOUR_POD -n YOUR_NAMESPACE
```

Read the status, container states, and Events section together. A scheduling problem, an image pull problem, and an application crash require different next steps. Treat the displayed status as a starting point, not a diagnosis.

## 2. Follow the evidence

| What you see | What to inspect next |
| --- | --- |
| Pending | Scheduling events, resource requests, node selection, and storage claims |
| ImagePullBackOff | Image reference, registry access, and image-pull credentials |
| CrashLoopBackOff | Container termination details and the previous container's logs |
| Running, but not ready | Readiness probe results and application dependencies |

For a container that has restarted:

```sh
kubectl logs YOUR_POD -n YOUR_NAMESPACE -c YOUR_CONTAINER --previous
kubectl logs YOUR_POD -n YOUR_NAMESPACE -c YOUR_CONTAINER --tail=100
```

The previous-container command is useful only when a previous instance is available. In a multi-container pod, name the container you are investigating.

## 3. Change one thing, then observe

Write down the failing condition, your hypothesis, and the smallest change that could disprove it. Keep a copy of relevant logs before changing the workload. Redact tokens, personal data, and internal addresses before sharing them.

A useful incident note can be only four lines:

```text
Observation: the pod cannot be scheduled.
Evidence: the scheduler reports insufficient requested memory.
Next check: compare requests with available node capacity.
Success condition: the pod schedules and becomes ready.
```

That note keeps the investigation honest. It also gives the next person something better than “we restarted it and it worked.”

## Keep this habit

Observe first. Form one hypothesis. Make one deliberate change. Check whether the result supports the hypothesis. A reliable debugging method is more useful than a long list of commands you cannot explain.

For the authoritative troubleshooting reference, see the [Kubernetes guide to debugging pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/).
