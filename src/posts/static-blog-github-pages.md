---
title: "A useful tech blog doesn't need a server."
description: "Why a Markdown-first, static publishing workflow is a good starting point for a personal engineering blog."
date: 2026-09-05T07:00:00Z
category: Cloud & DevOps
coverLabel: "Write. Build. Publish."
coverCode: "Markdown → HTML → Pages"
---
The hard part of starting a technical blog is usually not choosing a database. It is turning something you learned into something another person can use.

A static publishing workflow keeps the infrastructure small: write Markdown, build HTML, and publish the result. That is the approach behind The Code Clouds.

## The post is the source

Each article is a Markdown file with a small block of metadata: title, description, publication date, and topic. The build turns those files into article pages, archives, a search index, and a feed.

Eleventy performs that build here. Readers receive ordinary HTML and CSS; they do not need to download a client-side application just to read an article. Search is a small browser-side enhancement over a generated index.

## Keep publishing reviewable

An article can move through the same lightweight review loop as a code change: create a branch, check the rendered page, verify commands and sources, and merge when it is ready. Avoid publishing credentials, customer details, or internal screenshots in an example.

Drafts belong outside the published output. A public source repository is still public, though: marking an article as a draft does not make the source private.

## Know the boundary

GitHub Pages hosts static output, not your own application server. Features such as account-based subscriptions, payment processing, or a server-side editor require a different design. This site uses RSS instead of pretending a newsletter form stores subscriptions somewhere.

Pages also restricts sites primarily directed at commercial transactions. An engineering publication should stay editorial-first; course links are supplementary resources, not an on-site shop.

## Start with one useful article

Choose a problem you can explain clearly. Show the prerequisites, the steps, the expected result, and what to do when it does not work. A small, accurate guide beats an elaborate publishing stack with nothing to read.

References: [Eleventy documentation](https://www.11ty.dev/docs/), [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), and [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
