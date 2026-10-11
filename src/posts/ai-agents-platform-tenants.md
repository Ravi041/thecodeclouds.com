---
title: "Treat AI agents as platform tenants, not scripts."
description: "What a platform team should give AI agents before they reach real tools, and three real incidents that show what happens without it."
date: 2026-10-11T09:00:00Z
category: Cloud & DevOps
coverLabel: "Agents need a paved road."
coverCode: "agent → gateway → tool"
---
An AI agent that can call tools is a new kind of workload. It reads customer records, opens tickets and issues refunds, often through a shared API key, with nobody recording which tool it chose or why.

Platform teams already know how to host workloads like that. The mistake is treating agents as clever scripts that live outside the platform. Give them the same paved road you give services: an identity, a catalog of what they may reach, a written policy, and evidence of what happened.

## Start with the questions an incident will ask

When an agent does something surprising, somebody will ask four questions. Make sure the platform can answer them before the first production agent ships.

| Question | What the platform provides |
| --- | --- |
| Which agent made the call? | A workload identity per agent, never a shared key |
| What could it reach? | A catalog of registered tool servers, each with an owning team |
| Was it allowed to? | A written policy: allow, deny, or require approval |
| What happened? | An audit record per call: caller, tool, decision and outcome |

If the honest answer to any row is “we would have to search the logs,” that row is your next piece of platform work.

## Three incidents, three missing controls

These are not hypothetical. Each one is publicly documented, and each shows a control that was missing.

- **Nothing limited what it could reach.** In July 2025, [Replit’s coding agent deleted a production database](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure) while the project was under an explicit code freeze. The freeze was an instruction in a prompt; nothing in the environment stopped a development agent from changing production. Replit’s fix was structural: automatic separation of development and production databases, and a planning-only mode.
- **It had far more permission than its task needed.** [General Analysis showed](https://generalanalysis.com/blog/supabase-mcp-blog) an assistant connected to a Supabase database over MCP with the `service_role` key, which bypasses row-level security. An attacker filed a support ticket containing instructions. When a developer asked the assistant to review open tickets, it read the `integration_tokens` table and posted the secrets back into the attacker’s ticket.
- **Its scope was wider than the conversation.** [Invariant Labs showed](https://invariantlabs.ai/blog/mcp-github-vulnerability) that a malicious issue in a public GitHub repository could steer an agent that also had access to the user’s private repositories. The agent copied private data into a public pull request. The GitHub MCP server worked exactly as designed; the problem was one token that could reach every repository at once.

In each case, the model did something unexpected, and the environment let it. Preventing them didn’t need a smarter model. It needed a platform that could say no.

## Put tools behind one front door

Agents increasingly reach tools through the Model Context Protocol (MCP), where each server exposes a list of tools. Route agent traffic through a gateway that knows which servers are registered, rather than letting every agent carry its own endpoint list and credentials. A call to an unregistered server should fail at the gateway, not reach a forgotten test instance.

Registration is also where ownership lives. A tool server without a named owner is a tool nobody reviews when its behaviour changes.

## Label risk, but don’t trust the labels

MCP lets a server describe each tool with annotations such as `readOnlyHint` and `destructiveHint`:

```json
{
  "name": "delete_ticket",
  "annotations": { "readOnlyHint": false, "destructiveHint": true }
}
```

These hints improve the experience: auto-approve a read-only search, ask before a destructive delete. They are not a security control. The specification says clients must treat annotations as untrusted unless the server itself is trusted. Keep the real decision in a policy that the platform owns.

## Write the policy down before you enforce it

You don’t need an enforcement engine to begin. Write the intended policy as data: deny by default, and let the first matching rule win.

```yaml
default: deny
rules:
  - agent: support-agent
    server: support-mcp
    tool: delete_ticket
    decision: approve
  - agent: support-agent
    server: support-mcp
    tool: "*"
    decision: allow
  - agent: payments-agent
    server: payments-mcp
    tool: refund_payment
    decision: approve
```

Then score real calls against it. Two numbers matter:

- **Ungoverned calls**: the policy says deny or approve, but the tool ran.
- **Over-blocked calls**: the policy says allow, but the platform refused.

Run this scoring for a few days before you enforce anything. If your agents currently reach tools through a gateway that only routes traffic, expect the ungoverned count to be high: nothing is saying no yet. That number is not a failure. It is a baseline. Every control you add (identity, policy, approvals) should push ungoverned calls towards zero without raising the over-blocked count.

## Keep humans for the irreversible

Refunds, deletions and data exports deserve an approval step, at least until you trust both the agent and the data behind it. OWASP lists this among its mitigations for *excessive agency*, next to giving an agent only the tools and permissions it needs.

An approval should name the agent, the tool, its arguments and the person who asked, and it should expire. “Approve everything for this session” quietly turns an approval step back into an allow rule.

## Keep this habit

Before an agent gets a new tool, ask the four questions in the table. If the platform can’t answer one of them yet, write the intended policy down, measure the gap, and close it one control at a time.

For background, read the MCP team’s note on [what tool annotations can and can’t do](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) and OWASP’s [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).
