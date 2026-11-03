# UX audit, November 2026

Scope: site and wallet app (`website/`). Method: automated scans in the browser pane (contrast ratio per text node, tap-target size, horizontal overflow, missing alt/names, heading count) at desktop and 375px phone width, dark and light, against a local build; plus screenshots of the wallet dashboard.

## Design guidance used

The brief named the GitHub repo `benjitaylor/skills`. It was read read-only (`gh api`), not installed. It contains one skill, **stageshow**, for building faux product UI illustrations (React kit, motion, framing). It is not a UI/UX audit guide, so none of it was applied. Nothing in what was read tells an agent to change settings, though stageshow expects `npm install`, vite and playwright for its own playground. `npx skills add` was not run. The audit followed the existing impeccable, design-taste, emil-design-eng and apple-design guidance instead, and kept the current look (compact type, black/white/grey, indigo accent).

## Found and fixed

| Issue | Where | PR |
| --- | --- | --- |
| Dashboard "Everything Aretia does" tiles hard-coded a light fill: white label on white (contrast 1.02) in dark mode. Four tiles also left an orphan row. | Wallet dashboard | #340 |
| Brand indigo used as text on the dark canvas, 2.9 to 3.7:1: Markets filter chips, Shield tabs, "Your pools and fees" / "Promote your token" link buttons, inline links in Carbon and Safe Send panes. | Wallet, dark | #340 |
| Advert carousel dots 9x9px (11 of them), unusable by touch. | Home | #341 |

After #340 the dark-mode contrast scan is clean on every wallet pane (unconnected state).

## Found, not fixed

- Light mode: positive-change figures in the Markets table (`.wapp-mt__num.is-up`) measure 4.39:1, just under 4.5. Needs a slightly darker green token.
- Wallet pane text links in Carbon and Safe Send panes are 16px tall on phone (inline in paragraphs, so low priority).
- Shield suggestion chips are 31px tall on phone.
- FAQ page: several inline "Verify" links are 17px tall.
- "Take a tour" help button is 30px tall.
- The scan reported 1.06:1 for the light-mode Shield hero; likely a false positive because the scan ignores background gradients/images. Needs a visual check.
- Phone wallet navigation is a wrapped block of pills (about 136px on the local build); the live site showed it taller at the time of the first look. Worth a horizontally scrolling bar or bottom bar, but that is a larger design change.
- Not audited at all: blog posts, docs subpages, Radar, Launch Box and Launch with real data, dialogs and error states, tours, notifications.

## Not seen or tested

- No connected wallet: every view was seen in its unconnected state only. Balances, positions, Launch, Pay, swap confirmation and signing flows were not exercised, so nothing about fee or risk text in those flows was changed or verified here.
- Contrast numbers come from a script that composites flat background colours, so gradients, images and overlays are not covered.
- Screenshots were reviewed for the dashboard only. Light mode and phone width were checked by script, not by eye, beyond the first phone screenshot.
- No physical phone. Tap areas were measured, not touched.
- Local tests: 2 known unrelated failures on Windows (cloudflare-config line endings, feeKeyMonitor). CI was green on each merged PR.
