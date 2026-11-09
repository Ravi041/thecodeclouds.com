---
title: "Which AI model should you use? A November 2026 field guide"
description: "The current models from Anthropic, OpenAI, Google, DeepSeek and the open-weight labs, what they cost, how they score on independent benchmarks, and how to pick one."
date: 2026-11-07T11:00:00Z
category: AI Engineering
coverLabel: "Pick the model\nfor the job."
coverCode: "score / $ / task"
coverMotif: bars
coverLogos: "claude-icon, openai-icon, google-gemini"
coverImage: /assets/images/covers/ai-models-november-2026.jpg
coverImageAlt: "AI Engineering cover reading 'Pick the model for the job.', with the Claude, OpenAI and Gemini logos."
---
Every few weeks someone asks me which model they should use. The honest answer is "it depends", but that's not very useful, so here's the longer version: what's actually on offer right now, what it costs, how the models compare on independent tests, and a simple way to choose.

One warning before the numbers. This space moves monthly. Everything below was checked on **7 November 2026**, and I've put the date and source next to every figure so you can tell when it's gone stale.

<figure class="diagram"><img src="/assets/images/articles/ai-models-intelligence-index.svg" alt="Bar chart of the Artificial Analysis Intelligence Index in November 2026. Gemini 4 Carbon scores 60, Claude Opus 5.5 59, GPT-6 Astra 57, GPT-6.1 Sol and Claude Sonnet 5.5 55, Claude Fable 5.1 50, Kimi K3.1 Pro 46, Claude Haiku 5.5 36, Grok 4.7 35, Qwen3.8 Max 34, DeepSeek V4.1 Flash 33 and GLM-5.3 32, with the cost to run the index beside each bar." width="900" height="616" loading="lazy"><figcaption>The top three are within a few points of each other. The cost column varies by more than 25 times.</figcaption></figure>

## The short version

- **The frontier is a three-way tie.** Google's Gemini 4 Carbon, Anthropic's Claude Opus 5.5 and OpenAI's GPT-6 Astra sit within a few points of each other on every composite ranking I checked. Which one "wins" depends on the test.
- **The mid tier is where most work should go.** GPT-6.1 Sol and Claude Sonnet 5.5 score close to the flagships for a fraction of the price per token.
- **Small models got genuinely good.** Claude Haiku 5.5, GPT-6 Luna and DeepSeek's Flash model are priced at a few cents per million tokens or less, and handle classification, extraction and routing well.
- **Open-weight models are a real option**, not a hobby. Kimi K3.1 Pro, Qwen3.8 Max, GLM-5.3 and DeepSeek V4 are within reach of last year's flagships.

## What each vendor offers today

Prices are list prices per million tokens, input / output, from each vendor's own docs. Where a vendor doesn't publish a price on the page I read, I've said so rather than guess.

### Anthropic (Claude)

| Model | Best for | Price (in / out) | Context |
|---|---|---|---|
| Claude Fable 5.1 | The hardest, longest reasoning jobs | $10 / $50 | 1M |
| Claude Opus 5.5 | Coding agents, complex work, the everyday default in Claude Code | $4 / $20 | 1M |
| Claude Sonnet 5.5 | High-volume production work that still needs to be smart | $2 / $10 | 1M |
| Claude Haiku 5.5 | Fast, cheap tasks: routing, extraction, sub-agents | from $0.10 / $0.50 | 1M |

All four were released between mid-September and early October 2026 and support up to 128K output tokens. Opus 5.5 is the one most people will use for coding. Fable sits above it for long, hard problems where cost matters less than getting it right.

### OpenAI (GPT)

| Model | Best for | Price (in / out) | Context |
|---|---|---|---|
| GPT-6 Astra | Flagship reasoning | $10 / $50 | 1.05M |
| GPT-6.1 Sol | General-purpose workhorse | $2 / $10 | 1.05M |
| GPT-6.1 Terra | Cheaper general use | $1 / $5 | 1.05M |
| GPT-6 Luna | Small and fast | $0.10 / $0.50 | 1.05M |

Notice the pricing lines up almost exactly with Anthropic's tiers. That's not a coincidence. The two are competing tier for tier now.

### Google (Gemini)

Google's model page lists **Gemini 4 Argon** as the current flagship with a 1M context, alongside **Gemini 3.8 Flash** (new), 3.6 Flash, 3.5 Flash-Lite and a 3.1 Pro preview. **Gemini 4 Carbon**, the model topping the independent charts, is the higher-effort variant. The model page I read didn't list prices, so check the pricing page before you plan a budget.

### DeepSeek

DeepSeek's API now has two models: **deepseek-v4-pro**, generally available since 13 August 2026, and **deepseek-flash**, updated to V4.1-Flash on 17 October 2026. The weights are open, so you can also run them yourself. The Flash model stands out on cost: it ran the full Artificial Analysis index for about $0.60.

### The others worth knowing

- **Moonshot Kimi K3.1 Pro**: the highest-scoring open-weight model on the index right now (46).
- **xAI Grok 4.7**: scores 35, at a cost similar to the flagships.
- **Alibaba Qwen3.8 Max**: 34, with a large family of smaller open Qwen models below it.
- **Zhipu GLM-5.3**: 32, open weights and popular for self-hosting.
- **MiniMax-M3**: much further back at 19.

## How they compare on independent benchmarks

Vendors publish benchmark tables at launch, but they pick the tests and the settings. I'd rather look at people who run the same tests on everyone. Here are two.

### Artificial Analysis Intelligence Index

This combines a set of reasoning, knowledge, maths and coding evaluations into one score, and it also records what it cost to run the whole set. That second number is the one people skip, and it's the most useful.

| Model | Index | Cost to run the index |
|---|---|---|
| Gemini 4 Carbon (high) | 60 | $7.76 |
| Claude Opus 5.5 (max) | 59 | $10.04 |
| GPT-6 Astra (max) | 57 | $6.24 |
| GPT-6.1 Sol (max) | 55 | $1.27 |
| Claude Sonnet 5.5 (max) | 55 | $10.02 |
| Claude Fable 5.1 (xhigh) | 50 | $10.85 |
| Kimi K3.1 Pro | 46 | $3.68 |
| Claude Haiku 5.5 (max) | 36 | $0.41 |
| Grok 4.7 (xhigh) | 35 | $7.77 |
| Qwen3.8 Max | 34 | $10.02 |
| DeepSeek V4.1 Flash (max) | 33 | $0.60 |
| GLM-5.3 (max) | 32 | $5.01 |

*Source: artificialanalysis.ai, read 7 November 2026.*

A few things jump out:

- **Effort settings change the picture.** Gemini 4 Carbon scores 58 at medium effort ($6.59) and 60 at high. Opus 5.5 scores 57 at xhigh ($6.05) and 59 at max. You pay for the last two points.
- **GPT-6.1 Sol is the value pick on this index.** It matches Sonnet 5.5's score at about an eighth of the cost to run, mostly because it used fewer tokens.
- **A lower index score doesn't make a model worse at your task.** Fable 5.1 scores below Opus 5.5 here, yet it ranks near the top on long, hard maths and reasoning tests. A composite score blends everything together, and your workload probably isn't an even blend.

### BenchLM composite (6 November 2026)

BenchLM weights a different set of tests, and it puts the same group on top:

| Model | Score |
|---|---|
| Gemini 4 Carbon | 88.7 (estimated) |
| Claude Opus 5.5 | 86.3 |
| GPT-6 Astra | 85.8 |
| GPT-6.1 Sol | 85.4 |
| Gemini 4 Argon | 82.1 |
| Claude Sonnet 5.5 | 81.8 |
| Claude Fable 5.1 | 81.3 |
| GPT-6.1 Terra | 80.7 |

*Source: benchlm.ai, 6 November 2026. Carbon's score is marked as estimated by the site.*

When two independent rankings agree on the top three, I'm fairly comfortable calling it a tie.

### Individual benchmarks, and their limits

People often quote single benchmarks like SWE-bench (fixing real GitHub issues) or GPQA (graduate-level science questions). The most complete per-benchmark table I could find is from **18 August 2026**, which means it covers the *previous* generation of models:

| Benchmark | What it tests | Leaders in August |
|---|---|---|
| SWE-bench Verified | Fixing real bugs in open-source repos | Claude Opus 4.7 83.5, GPT-5.5 80.6, Gemini 3.5 Flash 79.3 |
| Terminal-Bench 2.0 | Working in a shell to finish tasks | Claude Opus 4.7 90.2, GPT-5.5 84.7 |
| GPQA Diamond | Hard science questions | GPT-5.4 Pro 94.6, Gemini 3.1 Pro 94.1 |
| Humanity's Last Exam | Very hard expert questions | Gemini 3.1 Pro 46.4, GPT-5.4 Pro 44.3 |
| FrontierMath | Research-level maths | GPT-5.5 Pro 87.7, Claude Fable 5 87.0 |

*Source: lmcouncil.ai snapshot, 18 August 2026.*

I'm including it because the pattern has held for a while: Claude models tend to lead on agentic coding, OpenAI and Google trade places on knowledge and science questions, and the maths leaderboard is close. But the September and October releases haven't been run through all of these yet, so treat this table as a hint about strengths, not current scores. Several tests are also close to saturated. When everyone scores above 90, the gaps say more about noise than about ability.

## How I'd actually choose

Benchmarks narrow the field. They don't make the decision. This is the process I use:

1. **Start with the mid tier.** Sonnet 5.5 or GPT-6.1 Sol. Most tasks never need more.
2. **Write 20 real examples** from your own work, with the answer you'd accept. This is your benchmark, and it's the only one that matches your data.
3. **Run them on two or three models** and compare quality, speed and cost. A simple script with each vendor's SDK is enough.
4. **Move up only where it fails.** If the mid tier gets 18 of 20, check whether the flagship gets the other two before you pay double or more for everything.
5. **Move down wherever you can.** Classification, extraction, summaries and routing are usually fine on Haiku, Luna or DeepSeek Flash.
6. **Mix models in one system.** A common setup is a flagship planning the work and a small model doing the many little steps. In Claude Code that's Opus as the main model with Haiku-powered subagents.

Some practical tie-breakers when scores are close:

- **Coding agents:** I'd start with Claude Opus 5.5. It's the default in Claude Code, and Claude models have led the agentic coding tests for several generations.
- **Lowest cost at decent quality:** GPT-6.1 Sol, or DeepSeek V4.1 Flash if you can accept a lower ceiling.
- **Data can't leave your network:** the open-weight models (Kimi, Qwen, GLM, DeepSeek) on your own GPUs. My post on [serving LLMs on Kubernetes](/blog/kubernetes-llm-serving/) covers the setup.
- **You're already on one cloud:** the vendor available through your cloud's marketplace often wins on procurement and data agreements alone.

## Things that will be out of date soon

Prices drop, new versions ship, and leaderboards get re-run. If you're reading this more than a couple of months after November 2026, use the structure here (vendor docs for prices, two independent rankings, your own 20 examples) and redo the numbers. That process will outlast any table.

## Sources

- [Anthropic: Models overview](https://platform.claude.com/docs/en/models/overview), read 7 Nov 2026
- [OpenAI: Models](https://developers.openai.com/api/docs/models), read 7 Nov 2026
- [Google AI Studio: Gemini models](https://aistudio.google.com/docs/models), read 7 Nov 2026
- [DeepSeek: V4.1-Flash release note](https://api-docs.deepseek.com/news/news261017), 17 Oct 2026
- [Artificial Analysis: Model leaderboard](https://artificialanalysis.ai/leaderboards/models), read 7 Nov 2026
- [BenchLM: Frontier AI models](https://benchlm.ai/frontier-ai-models), 6 Nov 2026
- [LM Council benchmark snapshot](https://lmcouncil.ai), 18 Aug 2026
