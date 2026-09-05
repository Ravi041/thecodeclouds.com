---
title: "Read the Terraform plan, not just the green check."
description: "A small review routine for spotting replacements, unexpected drift, and changes that deserve a second look."
date: 2026-09-05T07:30:00Z
category: Terraform
coverLabel: "Plan before apply."
coverCode: "$ terraform plan"
---
A successful pipeline tells you that a command finished. It does not tell you that the proposed infrastructure change is the one you intended.

Treat a Terraform plan as a review document. Before opening it, write down the change you expect. “Increase the worker pool size” is a much more useful starting point than “update infrastructure.”

## Start with the working context

Check the repository, directory, backend configuration, selected workspace, and credentials. A correct change in the wrong environment is still the wrong change.

```sh
terraform workspace show
terraform validate
terraform plan
```

Run these inside an already initialized, authorized working directory. Planning does not apply the proposed changes, but it can read remote infrastructure through the configured credentials.

## Review the shape of the change

Read beyond the summary count. Look for unexpected destruction, replacement rather than an in-place update, resource-address changes, and values that remain unknown until apply. Ask why each affected resource needs to change.

For every surprising difference, pause and investigate. A harmless formatting change should not quietly become a database replacement.

## Keep the reviewed plan and execution connected

In an approved delivery workflow, a saved plan can connect review with execution:

```sh
terraform plan -out=tfplan
terraform show tfplan
```

The saved file can contain sensitive data. Do not commit it, attach it to a public issue, or leave it in a broadly accessible build artifact. Treat it as a short-lived, access-controlled artifact. This guide intentionally stops before applying infrastructure.

## Leave a short review note

Record what should change, what should remain untouched, and how you will verify the result afterward. Include a recovery approach that fits the actual resource; “run the pipeline again” is not always a rollback.

A good review makes the intended outcome clear to somebody who was not in the room when the change was proposed.

See the official [Terraform plan reference](https://developer.hashicorp.com/terraform/cli/commands/plan) for plan modes, saved-plan behavior, and security considerations.
