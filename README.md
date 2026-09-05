# The Code Clouds

A Markdown-first technology publication for **thecodeclouds.com**, built with Eleventy and hosted only on GitHub Pages. There is no application server, CMS subscription, database, or additional hosting provider.

## What is included

- Responsive editorial homepage and article layouts.
- Light/dark header toggle, device-preference default, and device-local persistence. It works with keyboard and touch; without JavaScript the system theme still applies. The original archived portfolio retains its earlier design.
- Colourful topic covers and two optimized original editorial images, with image-specific social previews and descriptive alt text.
- Article archive with pagination, topic archives, and browser-side full-text search.
- Four original starter articles for editorial review before launch.
- Atom/RSS subscription, sitemap, canonical links, social title/description metadata, and a custom 404 page.
- Official learning-resource links and an offer system with verification dates, expiry, optional coupon codes, and affiliate/sponsor disclosures.
- About page and the previous personal portfolio preserved at `/portfolio/`. Its content is unchanged except for a link back to the publication; review the old placeholder talks/contact details before promoting that page.
- Automated build, content, local-link, metadata, desktop/mobile, and accessibility checks.

## Preview locally

Install Node.js 24 LTS, then run from this repository:

```sh
npm ci --ignore-scripts
npm run dev
```

Open **http://localhost:8088/**. Stop the local preview with Ctrl+C. On Windows, use `npm.cmd` if PowerShell prevents loading `npm.ps1`; no execution-policy change is necessary.

```sh
npm run check
npx playwright install chromium
npm run test:browser
```

The browser test serves its own isolated local preview, runs desktop and mobile checks, and saves screenshots in `test-results/`. It does not visit external providers or use your personal browser profile. To use an already installed Chrome on Windows:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm.cmd run test:browser
```

`npm run build` replaces only the generated `_site/` directory. Never hand-edit `_site/`; draft removal and expiry need a clean build. A development preview is not the final release artifact.

## Publish a new article

1. Create a content branch (for example, `feature/kubernetes-probes-guide`).
2. Copy `templates/post.md` to `src/posts/kubernetes-probes-guide.md`.
3. Edit its metadata and write the article in Markdown.
4. Check the original documentation, commands, expected results, and cleanup instructions. Never include credentials or private customer information.
5. Set the real publication date, remove `draft: true` or set it to `false`, and preview/check the result.
6. Commit the changes and open a pull request into `main`. After the launch setup below, merging a passing PR rebuilds and deploys the site.

The filename becomes the stable URL: `/blog/kubernetes-probes-guide/`. Renaming it after publication breaks incoming links unless you deliberately preserve the old URL.

```yaml
---
title: "Readiness probes: what healthy really means"
description: "What a readiness probe checks, and how to test it safely."
date: 2026-09-05T12:00:00Z
category: Kubernetes
draft: true
coverLabel: "Healthy is not ready."
coverCode: "$ kubectl describe pod"
---
```

Available categories are `Kubernetes`, `Cloud & DevOps`, `Terraform`, and `Career & Learning`. Add a topic in `lib/content.js` to extend this list. The metadata validator catches misspelled categories.

Drafts and future-dated posts are excluded from article pages, homepage, archives, search, feed, and sitemap—including the development preview. To preview a draft, temporarily set it to `draft: false` with a current/past date locally, then restore the flag before committing. **A draft in a public GitHub repository is still visible in the source.**

Keep at least one published article. The homepage chooses the most recently dated article. Start with the four included articles or replace them with your own reviewed writing; do not present untested examples as validated operational runbooks.

Use ordinary Markdown headings, lists, links, tables and fenced code blocks. Put your own licensed images under `src/assets/images/` and embed them with descriptive alt text:

```md
![Readiness probe requests reaching the demo pod](/assets/images/readiness-probe.png)
```

For a cover image on the article, cards, and social previews, add `coverImage: /assets/images/your-cover.webp` and `coverImageAlt: A meaningful description` to its metadata. Use your own licensed PNG, JPEG, WebP, or AVIF files; 1200×675 is a useful cover size. Without an image, cards use the article’s `coverLabel` and `coverCode`. The featured visual follows the latest article instead of reusing an unrelated illustration.

Use `coverCredit` for a source attribution or AI-generation disclosure under the article cover. The two launch covers are AI-generated editorial images, not documentary photographs. See `IMAGE-CREDITS.md` for their origin and exact generation prompts. They are served locally as 1200×675 JPEGs below 120 KB each; no third-party image requests are needed. On Windows, `scripts/optimize-cover.ps1 -Source path/to/original.png -Destination src/assets/images/new-cover.jpg` creates a web-sized JPEG without overwriting an existing file.

The top metadata block can be edited in GitHub’s web editor; a separate CMS is not required. For simple updates, create a branch in GitHub, edit the Markdown file, and open a pull request.

## Add an approved course offer

There are deliberately **no invented discounts or affiliate accounts** in this repository. `src/_data/offers.json` starts as an empty array. The example under `templates/` is a draft fixture and is never shipped.

1. Get the approved provider/affiliate destination, discount wording, code, eligibility and expiry.
2. Copy the object from `templates/offer.example.json` into the array in `src/_data/offers.json`.
3. Replace **every** example value. Remove the `code` property when no coupon is required.
4. Record when you checked it in `verifiedAt`, and the exact expiry in `expiresAt`, including timezone.
5. Set `affiliate` and `sponsored` accurately; these flags control visible disclosures and `rel="sponsored nofollow"` on the link.
6. Remove `draft: true` only after verification, then build/test and submit the change for review.

Expired offers are omitted during builds. Browser-side expiry also hides a card after its deadline while a page is open. The workflow rebuilds daily at approximately 04:17 UTC, supporting scheduled posts and offer cleanup. GitHub can delay scheduled workflows and disable schedules in inactive public repositories; monitor Actions and run the workflow manually if needed. With JavaScript disabled, expiry reflects the last successful build and the printed deadline.

Provider links, titles, and terms live in Git. There is no visitor-side editing or submission endpoint. Never place API keys, affiliate dashboard passwords, payment fields, or user tracking scripts in content.

## GitHub Pages launch: one-time migration

At the start of this change, Pages was configured to publish the root of `main` directly. The new site instead builds `_site/` through the included official GitHub Actions workflow. **The redesigned source branch must not be published using the old “Deploy from a branch” setting.**

When the design and starter articles are approved:

1. Push `feature/tech-publication` and open a PR to `main`. Confirm its build and browser checks pass. These branch/PR checks do not deploy.
2. In **Repository → Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. Keep the existing `thecodeclouds.com` custom domain and HTTPS setting. No DNS change is intended.
3. Merge the approved PR into `main`.
4. Watch **Actions → Build and publish GitHub Pages**. Only `main` deploys, and deployment requires a successful build/test job.
5. Verify the public homepage, an article, search, learning page, `/feed.xml`, and `/portfolio/` at `https://thecodeclouds.com/`.

No personal access token or extra hosting account is required. The workflow uses GitHub’s scoped Pages deployment permissions. It does not force the Pages setting or modify the domain. The first deployed version is not complete until the live-site checks pass.

### Rollback

Before launch, record the current main commit (`7445152` at the beginning of this work). To revert a launched redesign, restore the previous known-good commit through a reviewed revert/PR and restore Pages’ prior **Deploy from a branch → main → / (root)** source. Keep `CNAME` and HTTPS unchanged. Do not delete your custom domain or use a force push as a rollback.

## GitHub Pages and monetization boundaries

The site is an editorial blog with supplementary external learning links, not a course storefront, SaaS, paid-member area, or checkout. GitHub Pages restricts websites primarily directed at facilitating commercial transactions. Keep this distinction in the business model and seek confirmation from GitHub before making affiliate advertising the primary purpose of the site. See [GitHub Pages usage limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

Affiliate and sponsored content must be disclosed clearly. The included disclosure/privacy pages describe this implementation; review them for your actual arrangements and applicable obligations before monetizing. The current site has no analytics, newsletter database, cookie-based ad system, or fake contact form. RSS works without a third-party service.

## Project layout

```text
src/posts/          Markdown articles
src/_data/         Site identity, resource links, and offers
src/_includes/     Shared page and article templates
src/assets/        Local CSS, JavaScript, icons, and your images
src/portfolio/     Preserved original personal site
templates/         Non-published authoring examples
lib/               Content validation and publication rules
scripts/           Clean build and isolated browser checks
test/              Regression tests
_site/             Generated static artifact (ignored by Git)
.github/workflows/ GitHub Pages build/test/deploy workflow
```

Other Kavrynt workspace repositories are not used by or changed for this site.
