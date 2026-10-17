---
title: "A GPU is not a bigger CPU. Schedule it like one and your pod waits."
description: "How Kubernetes actually allocates GPUs to AI workloads: whole devices, taints, sharing with isolation in mind, and Dynamic Resource Allocation."
date: 2026-10-17T06:00:00Z
category: Kubernetes
coverLabel: "Whole GPUs, or a claim."
coverCode: "$ kubectl get resourceslices"
---
The first AI workload on a cluster usually starts the same way. Somebody adds `nvidia.com/gpu: 1` to a training job, applies it, and watches the pod sit in `Pending`. Then somebody else’s web service lands on the expensive GPU node and uses none of its GPUs.

Kubernetes can schedule GPUs well, but not the way it schedules CPU and memory. CPU can be shared in slices, overcommitted and throttled. A GPU is a device: something has to advertise it, a pod gets all of it, and keeping the wrong work off it is up to you.

## What the scheduler actually sees

Kubernetes has no built-in idea of a GPU. A vendor **device plugin**, running on each GPU node next to the driver, advertises the devices as an extended resource such as `nvidia.com/gpu` or `amd.com/gpu`. If the plugin isn’t running, the node reports no GPUs, and every GPU pod waits for good reason.

Check what each node offers before you debug a workload:

```sh
kubectl get nodes -o custom-columns='NODE:.metadata.name,GPUS:.status.allocatable.nvidia\.com/gpu'
kubectl describe node YOUR_GPU_NODE | grep -A 10 "Allocated resources"
```

Both commands are read-only. A node showing `<none>` has no GPUs advertised: look at the driver and device plugin on that node before you look at the pod.

Extended resources follow stricter rules than CPU:

- **Ask in `limits`.** Kubernetes uses the limit as the request. If you set both, they must be equal, and a request without a limit is rejected.
- **Ask for whole devices.** `1` means one entire GPU. There is no `0.5`.
- **No overcommitting.** A GPU allocated to one pod is unavailable to every other pod until the first one ends.

That last rule is why an idle notebook holding a GPU all weekend is a real cost, not a cosmetic one.

## Keep other work off GPU nodes

A GPU node also has CPU and memory, so without a guard, the scheduler will happily place ordinary pods there. They can take the CPU and memory that a GPU job needs, leaving the GPUs stranded.

Taint GPU nodes, using the GPU resource name as the taint key:

```sh
kubectl taint nodes YOUR_GPU_NODE nvidia.com/gpu=present:NoSchedule
```

This one isn’t read-only: it changes where new pods may run, so agree it with the cluster owners first. Many managed GPU node pools let you set the taint when you create the pool, which is better than tainting by hand.

If the `ExtendedResourceToleration` admission controller is enabled, Kubernetes adds the matching toleration to any pod that requests `nvidia.com/gpu`. GPU workloads get in; everything else stays out, and nobody has to remember a toleration.

When nodes carry different GPU models, label them and select the one a workload needs:

```yaml
spec:
  nodeSelector:
    accelerator: example-gpu-80gb   # your own label, or one from Node Feature Discovery
  containers:
    - name: trainer
      image: registry.example/trainer:v1
      resources:
        limits:
          nvidia.com/gpu: 1
```

Node Feature Discovery, with a vendor plugin, can apply labels such as GPU memory and model automatically, so labels stay accurate as nodes come and go.

## Share a GPU only when you mean it

Many inference and notebook workloads use a fraction of a modern GPU. Sharing is tempting, and NVIDIA’s GPU Operator offers two ways to do it. They are not equivalent.

| Approach | What a pod gets | Isolation between pods |
| --- | --- | --- |
| Whole GPU (the default) | One entire device | Complete |
| Time-slicing | A turn on a device it shares with other pods | None for memory or faults |
| MIG (Multi-Instance GPU) | A fixed hardware partition of a supported GPU | Memory and faults isolated in hardware |

Time-slicing makes one GPU look like several: with four replicas, a node with one GPU advertises four. But NVIDIA is explicit that, unlike MIG, there is no memory or fault isolation between replicas. One pod that allocates too much memory can make its neighbours fail. Asking for two time-sliced replicas doesn’t give a pod twice the compute, either.

Use time-slicing for development and for trusted, small workloads that belong to one team. Use MIG, or whole GPUs, when tenants or production services share the hardware. If you turn on time-slicing, enable the option that renames the resource to `nvidia.com/gpu.shared`. Then a workload has to ask for a shared GPU on purpose and never receives one by accident.

## When a count isn’t enough: Dynamic Resource Allocation

`nvidia.com/gpu: 1` can’t say “a GPU with at least 40 GiB of memory” or “two GPUs on the same interconnect.” **Dynamic Resource Allocation (DRA)** can. Its core API, `resource.k8s.io/v1`, graduated to stable in Kubernetes v1.34.

With DRA, a vendor driver publishes each node’s devices and their attributes as **ResourceSlices**. An administrator defines **DeviceClasses**. A workload asks for devices through a **ResourceClaim**, using a CEL expression to describe what it needs:

```yaml
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: large-gpu
spec:
  spec:
    devices:
      requests:
        - name: gpu
          exactly:
            deviceClassName: gpu.example.com
            selectors:
              - cel:
                  expression: device.capacity["gpu.example.com"].memory.compareTo(quantity("40Gi")) >= 0
---
apiVersion: v1
kind: Pod
metadata:
  name: trainer
spec:
  resourceClaims:
    - name: gpu
      resourceClaimTemplateName: large-gpu
  containers:
    - name: trainer
      image: registry.example/trainer:v1
      resources:
        claims:
          - name: gpu
```

The device class name and attribute names come from the vendor’s DRA driver, so copy them from what your cluster publishes, not from this example:

```sh
kubectl version
kubectl get deviceclasses
kubectl get resourceslices
```

Empty output means no DRA driver is installed. In that case, the device-plugin model above is still how your cluster allocates GPUs. DRA needs a driver from the GPU vendor; upgrading Kubernetes alone isn’t enough.

## Read a Pending GPU pod

Start with `kubectl describe pod`, then match the scheduling event:

| Event message includes | What to check next |
| --- | --- |
| `Insufficient nvidia.com/gpu` | Allocated GPUs on each node, and which pods hold them |
| `untolerated taint` | The pod’s tolerations, and whether it requests a GPU at all |
| `didn't match Pod's node affinity/selector` | The GPU model labels on the nodes |
| `cannot allocate all claims` | The ResourceClaim’s selectors against published ResourceSlices |

If the cluster autoscaler adds GPU nodes, a pending GPU pod may simply be waiting for a node to boot and its driver to load. That often takes several minutes. Check the autoscaler’s events before changing the workload.

## Keep this habit

Before you onboard an AI workload, write down three things: the GPU model and memory it needs, whether it can share a device and with whom, and which node pool it runs on. Those answers turn into a selector, a resource request and a taint. Most `Pending` GPU pods come down to one of the three being missing.

The authoritative references are the Kubernetes guides to [scheduling GPUs](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/) and [Dynamic Resource Allocation](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/), the [Kubernetes v1.34 release notes](https://kubernetes.io/blog/2025/08/27/kubernetes-v1-34-release/), and NVIDIA’s [GPU sharing guide](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html).
