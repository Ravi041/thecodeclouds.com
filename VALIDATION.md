# Publication validation

Date: 2026-09-05. Branch: `feature/tech-publication`, based on main commit `7445152`.

## Result

The local publication is built and tested, including the requested colourful refresh and light/dark toggle. The owner has approved push, merge into main, and launch. Remote CI and live verification are the remaining release gates at this pre-release checkpoint; their results are recorded in the GitHub Actions run and pull request. The existing domain and HTTPS setting must be preserved.

## Passing checks

- `npm run check`: clean Eleventy build, 22 generated files plus nine copied assets/files, and 20 passing automated tests.
- Content tests: metadata validation, local cover-image paths/alt requirements, date/draft rules, offer expiry, checked dates, safe provider links, explicit affiliate/sponsor flags, and safe JSON encoding.
- Isolated publication build: drafts and future posts absent from article routes, home/archive/topic lists, search index, sitemap, and feed; expired offers absent; synthetic active offers correctly disclosed. These fixtures are never published.
- Generated local links, anchors, scripts, assets and canonical URLs resolve. Domain file, Pages marker, feed, sitemap, and article metadata verified.
- Browser checks using Playwright with a fresh headless Chrome profile: desktop at 1440×1050 and mobile iPhone-13 viewport emulation. No personal browser profile was used.
- Navigation, mobile menu/Escape behavior, search/results/empty state, search text escaping, offer expiry, image loading and horizontal overflow checks passed in both themes.
- Axe WCAG 2 A/AA and 2.1 AA automated checks passed for 11 pages at both viewports in both themes: 44 page checks. This is not a full manual accessibility certification.
- Theme keyboard interaction, saved preference across reload/navigation, OS theme changes, explicit override priority, 320px viewport and blocked-storage fallback passed.
- Reading, navigation, system theme and search fallback passed with JavaScript disabled in both themes.
- Two locally hosted AI-generated covers have visible article credits, alternative text and social metadata; each is under 120 KB. See `IMAGE-CREDITS.md` for final files and prompts.
- `npm audit --audit-level=high`: zero known vulnerabilities reported across the installed dependency tree at audit time.
- GitHub Actions workflow YAML parsed; official action references are pinned to reviewed commit SHAs. JavaScript syntax checks passed.

Screenshots are generated locally in `test-results/` (ignored by Git): desktop/mobile homepage, article, learning page, and first-viewport previews.

The preserved original portfolio was checked for local link integrity but was not redesigned or included in the new publication's accessibility claim. Its older placeholder talks and contact details still need the owner's review before promotion.

## Launch prerequisites

1. Review the design and the four original starter articles. They are starter editorial content, not independently executed operational runbooks.
2. Provide real affiliate links/approved discounts before adding any offers; none were invented or published.
3. Owner approval to commit/push and launch was received on 2026-09-05.
4. Change GitHub Pages Source from the existing branch/root configuration to **GitHub Actions**, preserving the custom domain and HTTPS setting.
5. Merge the approved PR into main, confirm the actual GitHub-hosted CI/deployment run, and verify the live site.

Remaining external validation: the new GitHub Actions workflow has not run on GitHub yet; the public deployment, actual Safari/mobile devices, and any future affiliate provider arrangements have not been tested. The existing preview is at `http://localhost:8088/` while its local server is running.

See `README.md` for writing posts, managing offers, previewing, deployment, and rollback. Keep the site editorial-first and review GitHub Pages' commercial-use restrictions before expanding monetization.
