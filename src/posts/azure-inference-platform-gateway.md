---
title: "An inference platform on Azure starts with the gateway, not the GPU."
description: "How to choose where models run on Azure, and the shared front door that turns them into a platform: identity, token limits, failover and cost per team."
date: 2026-10-11T10:00:00Z
category: Cloud & DevOps
coverLabel: "Tokens are the new quota."
coverCode: "$ az cognitiveservices usage list"
---
A team’s first model call on Azure is usually direct: one app, one endpoint and an API key in a configuration file. That works for a single app. By the fifth, nobody knows which team spent the month’s budget, one busy service can consume the whole deployment’s quota, and rotating the key means coordinating five releases.

An inference platform fixes this with a shared front door. Choose where each model runs per workload, but give every caller the same way in.

## Choose where each model runs

| If you need | Consider |
| --- | --- |
| Hosted models, billed per token, with no GPUs to operate | Microsoft Foundry standard deployments (Global Standard or Data Zone Standard) |
| Predictable latency for steady, high-volume traffic | Provisioned throughput (PTU) deployments in Foundry |
| Open-weight models on your own Kubernetes platform | AKS GPU nodes with the AI toolchain operator (KAITO) |

Start with standard deployments. Microsoft suggests Global Standard for most workloads: it has the broadest region coverage and the highest default quota. The trade-off is that prompts may be processed in any Azure region. If data must stay within the US, the EU or Asia Pacific, choose a Data Zone deployment. Make that decision in a design review, not by accepting a default.

Move traffic to provisioned throughput when it is steady enough to keep reserved capacity busy. Run models on AKS when you need a model, runtime or network boundary that the managed service doesn’t offer, and you are ready to operate GPU capacity.

## Know your quota before you design

Hosted models are limited in tokens per minute (TPM), assigned per subscription, per region and per model. Check what the target subscription actually has before anybody promises a launch date:

```sh
az account show --query name -o tsv
az cognitiveservices usage list --location eastus2 -o table
```

Both commands are read-only. Use a region you are genuinely considering: quota in one region doesn’t help a deployment in another.

## Put one gateway in front of every model

Azure API Management includes AI gateway capabilities for this job. Publish each model deployment as an API and give every consuming team its own gateway subscription. Four capabilities then do most of the platform work:

1. **No keys in apps.** The gateway calls Foundry with its managed identity, which holds the *Cognitive Services OpenAI User* role. Callers authenticate to the gateway, ideally with Microsoft Entra ID tokens.
2. **A fair share of tokens.** The `llm-token-limit` policy sets tokens per minute, a quota per period, or both, for each consumer.
3. **Cost per team.** The `llm-emit-token-metric` policy sends token counts to Application Insights, with dimensions such as the API and the consumer.
4. **Graceful failover.** A backend pool can prefer a provisioned deployment and spill over to a standard one, with a circuit breaker that respects the backend’s `Retry-After` header.

The first two fit in a short inbound policy:

```xml
<authentication-managed-identity resource="https://cognitiveservices.azure.com"
    output-token-variable-name="msi-token" ignore-error="false" />
<set-header name="Authorization" exists-action="override">
  <value>@("Bearer " + (string)context.Variables["msi-token"])</value>
</set-header>
<llm-token-limit counter-key="@(context.Subscription.Id)"
    tokens-per-minute="20000" estimate-prompt-tokens="false"
    remaining-tokens-header-name="x-remaining-tokens" />
```

When you import a model directly from Foundry, API Management can configure the managed-identity backend for you; the policy above shows what that setup does.

A caller over its per-minute limit receives `429 Too Many Requests`; a caller over a period quota receives `403 Forbidden`. Make sure client SDKs back off on `429` instead of retrying immediately. Counters are kept per gateway, so a multi-region deployment does not share one total.

## Decide what you log

Token counts are safe to keep. Prompts and completions are different: they can contain personal or confidential information. API Management can log them, but decide retention and access first, and protect that log like the data inside it.

## Keep this habit

Before onboarding a team, answer three questions: which deployment type and region does its data allow, what share of the TPM quota does it get, and which metric will show its spend? Once the gateway can answer all three, adding the next model becomes configuration, not a project.

Microsoft’s guides cover the details: [AI gateway capabilities in API Management](https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities), [Foundry deployment types](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types), [Foundry quotas and limits](https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits) and the [AI toolchain operator on AKS](https://learn.microsoft.com/en-us/azure/aks/ai-toolchain-operator).
