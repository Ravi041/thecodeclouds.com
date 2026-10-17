---
title: "Serving an LLM on Kubernetes: slow starts, heavy weights and the right scaling signal."
description: "Why a model server breaks the defaults you use for web apps, and how to set probes, model storage, autoscaling and routing for AI inference."
date: 2026-10-17T07:00:00Z
category: Kubernetes
coverLabel: "Scale on the queue."
coverCode: "vllm:num_requests_waiting"
---
Deploy a model server with the settings you use for a web service and three things go wrong in the first hour. The pod is killed while it is still loading the model. Every new replica downloads the same tens of gigabytes again. And the autoscaler, watching CPU, sees nothing worth reacting to while users queue for answers.

A large language model (LLM) server is still a Deployment behind a Service. But it starts in minutes rather than seconds, it reads gigabytes of weights before it can answer, and its bottleneck is the GPU, not the CPU. This article uses [vLLM](https://docs.vllm.ai/), a widely used open-source inference server, as the example. The same questions apply to other servers.

## Give it time to start

A model server can’t serve until the weights are in GPU memory. For a large model that can take many minutes, and it changes with the model, the disk and the network. With a liveness probe tuned for a web app, the kubelet restarts the container just before it would have finished. Then it restarts it again.

Use a **startup probe** for the long load. Until it succeeds, Kubernetes doesn’t run the liveness and readiness probes, so you can give startup a generous budget without making failure detection slow afterwards:

```yaml
containers:
  - name: model-server
    image: vllm/vllm-openai:PINNED_VERSION
    ports:
      - containerPort: 8000
    resources:
      limits:
        nvidia.com/gpu: 1
    startupProbe:
      httpGet: { path: /health, port: 8000 }
      periodSeconds: 10
      failureThreshold: 90      # up to 15 minutes to load the model
    readinessProbe:
      httpGet: { path: /health, port: 8000 }
      periodSeconds: 5
    livenessProbe:
      httpGet: { path: /health, port: 8000 }
      periodSeconds: 10
      failureThreshold: 3
```

Don’t guess the budget. vLLM’s Kubernetes guide recommends measuring it: run the server once without probes, time how long it takes to become ready, and set the threshold above that. If the startup probe is too short, the container log ends with `KeyboardInterrupt: terminated` and the pod’s events report a failed startup probe.

Pin the image to a specific version, too. A `latest` tag on a model server can change the runtime under a model that was tested against an older one.

## Decide where the weights live

Where the weights come from decides how long every start takes and who can change the model.

| Weights come from | Good for | Watch for |
| --- | --- | --- |
| A download from a model hub at startup | A first experiment | Every replica downloads again; a hub outage blocks scaling |
| A shared PersistentVolume | Many replicas of the same model | Read throughput of the storage; who can write to it |
| An OCI image volume | Versioned, cached, immutable models | Container runtime support; very large artifacts |
| The server image itself | Small models | Rebuilding a huge image for every model change |

**Image volumes** are worth a look. Since Kubernetes v1.36 they are stable and enabled by default. They let a pod mount an OCI artifact from your registry, read-only, next to the server image. The model gets a version tag, the node caches it like any image, and your registry’s access controls decide who can publish a new one:

```yaml
spec:
  containers:
    - name: model-server
      volumeMounts:
        - name: weights
          mountPath: /models
  volumes:
    - name: weights
      image:
        reference: registry.example/models/assistant:2026-10-01
        pullPolicy: IfNotPresent
```

The container runtime decides what kinds of artifact can be mounted. Check that your nodes’ runtime supports image volumes before you rely on them.

Whichever source you choose, record the model’s version in your Deployment. “Which model answered this request?” is a question an incident review will ask.

## Scale on the queue, not the CPU

CPU usage tells you almost nothing about a model server. The work happens on the GPU, and a server under heavy load can show modest CPU while requests pile up. Scale on the signals the server itself reports. vLLM exposes them in Prometheus format:

| Metric | What it tells you |
| --- | --- |
| `vllm:num_requests_waiting` | Requests queued because the server is at capacity |
| `vllm:num_requests_running` | Requests currently being processed |
| `vllm:kv_cache_usage_perc` | How full the KV cache is, from 0 to 1 |
| `vllm:time_to_first_token_seconds` | How long users wait for the first token |

The waiting queue is the clearest scaling signal: when it grows, users are already waiting. KEDA can scale a Deployment on a Prometheus query:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: model-server
spec:
  scaleTargetRef:
    name: model-server
  minReplicaCount: 1
  maxReplicaCount: 4
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 600
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc:9090
        query: sum(vllm:num_requests_waiting{model_name="assistant"})
        threshold: "5"
```

KEDA treats the threshold as a target per replica: with three replicas, this example scales out when more than 15 requests are waiting in total. Adjust the query’s labels to match your Prometheus setup.

Three details matter more for models than for web apps:

- **Keep a warm replica.** Scaling to zero saves GPU time, but the first request afterwards waits for a node, a pod and a full model load. Keep `minReplicaCount: 1` for anything interactive.
- **Scale down slowly.** A new replica costs minutes to start, so removing one during a short lull is expensive. The stabilization window above waits 10 minutes before scaling down. KEDA’s `cooldownPeriod` doesn’t do this: it applies only to scaling to and from zero.
- **Replicas need free GPUs.** Each new replica needs a whole GPU. If none is free, the pod stays `Pending` until the cluster autoscaler adds a node. Set `maxReplicaCount` to the capacity you can actually get.

## Route requests by load, not round robin

A Kubernetes Service spreads connections evenly. LLM requests are not even: one asks for ten tokens, the next for ten thousand. With even spreading, one replica can sit behind a long queue while another is idle.

The **Gateway API Inference Extension** addresses this. An `InferencePool`, stable at `inference.networking.k8s.io/v1`, groups model-server pods. Its **endpoint picker** watches each pod’s queue length, KV cache use and loaded LoRA adapters, and sends each request to the replica best placed to serve it:

```yaml
apiVersion: inference.networking.k8s.io/v1
kind: InferencePool
metadata:
  name: assistant
spec:
  selector:
    matchLabels:
      app: model-server
  targetPorts:
    - number: 8000
  endpointPickerRef:
    name: assistant-epp
    port:
      number: 9002
    failureMode: FailOpen
```

An `HTTPRoute` on a gateway that supports the extension then names the pool as its backend, in place of a Service. With `FailOpen`, the gateway still forwards traffic if the endpoint picker is unavailable. You lose the smart routing, not the service.

Start without it. Add it when replicas show uneven queues under real traffic, which the metrics above will tell you.

## Check the result

```sh
kubectl get pods -l app=model-server -n YOUR_NAMESPACE
kubectl get events -n YOUR_NAMESPACE --field-selector involvedObject.name=YOUR_POD
kubectl get scaledobject,hpa -n YOUR_NAMESPACE
```

All three are read-only. A healthy rollout shows each new pod passing its startup probe once, without restarts. A restart count that climbs during startup means the probe budget is too short. An HPA that never moves while users complain usually means the Prometheus query returns nothing. Run it in Prometheus directly before changing the threshold.

## Keep this habit

Before an LLM reaches production, measure three numbers on the real hardware: how long a replica takes to become ready, how many concurrent requests one replica handles before its queue grows, and how long a new GPU node takes to join. They set the startup probe, the scaling threshold and the replica limits. Settings copied from a web service set none of them correctly.

For the details, see the [vLLM Kubernetes deployment guide](https://docs.vllm.ai/en/latest/deployment/k8s.html), [vLLM’s metrics reference](https://docs.vllm.ai/en/latest/design/metrics.html), the Kubernetes documentation on [probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/) and [image volumes](https://kubernetes.io/docs/concepts/storage/volumes/#image), KEDA’s [Prometheus scaler](https://keda.sh/docs/latest/scalers/prometheus/), and the [Gateway API Inference Extension](https://gateway-api-inference-extension.sigs.k8s.io/).
