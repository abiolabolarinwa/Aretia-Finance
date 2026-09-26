# Website Go-Live Checklist — Domain to Deployed

**Scope note:** this checklist covers *the website going live at a real, public URL* — not the token trading, liquidity, or audit workstreams tracked in `TOKENOMICS.md` §07 and `MINT.md`. Those are separate and don't block this. A live website with no liquidity yet is an accurate, honest state (and matches everything the site itself already says); a live token no one can actually trade with a broken or missing website is not.

Status: drafted 4 Sept 2026. **Updated 26 Sept 2026** — steps 1 through 5 and most of 7 are done; the site is live at `aretiafinance.org` with working auto-deploy. Steps 6 (partially) and 8 remain open — see their checkboxes below for exactly what's left.

---

## 1. Register the domain

- [x] **`aretiafinance.org`** registered through GoDaddy, 4 Sept 2026. Matches the current entity name (Aretia Finance LLC) and avoids "coin," consistent with the 4 Sept rename.
- [x] DNS pointed and live — confirmed 26 Sept 2026: `aretiafinance.org` loads the real site with a valid HTTPS certificate.

## 2. Fix the git repository

- [x] Old repo, rooted at the entire Windows user folder with a placeholder remote, abandoned. A fresh git repository was initialized scoped to just the project folder, 5 Sept 2026.
- [x] Project folder renamed from `aretia-climate-coin` to `aretia-finance`, matching the entity name and domain.
- [x] Confirmed no unrelated personal files swept in: 43 files staged and committed, all project files. A repo-wide `.gitignore` was added excluding `node_modules/`, the local Solana test-validator ledger, and, as a safety net, any keypair-shaped `.json` file anywhere in the repo (a real disposable devnet keypair on disk was confirmed correctly excluded before the first commit, not just assumed).

## 3. Decide the GitHub setup and push the code

- [x] Created `abiolabolarinwa/Aretia-Finance` on GitHub, initially set to **Private** given several documents contained internal or not-yet-reviewed legal/business content. Those documents (attorney brief, foundation-structure memo, liquidity ask one-pager, entity-rename memo) have since been removed entirely, along with their history, ahead of going public.
- [x] Remote set, initial commit pushed, 5 Sept 2026. `main` branch tracking `origin/main`.

## 4. Choose hosting and connect it to the repo

- [x] **Vercel** chosen (see `website/vercel.json`).
- [x] Connected to the GitHub repo from Step 3 — confirmed repeatedly through Sept 2026: every push to `main` triggers a real deploy.
- [x] Default preview URL confirmed working before this was ever an issue — superseded by Step 5 confirming the real domain works.

## 5. Point the domain at the host

- [x] Custom domain added in Vercel's dashboard.
- [x] DNS updated at GoDaddy.
- [x] DNS propagated; `aretiafinance.org` loads the site with a valid HTTPS certificate (confirmed 26 Sept 2026).

## 6. Pre-launch content pass — fix what's still placeholder or unresolved

- [ ] **Confirm the Delaware entity amendment.** Every document currently says "Aretia Finance LLC — Delaware amendment in progress." Before the site is genuinely public, confirm with your registered agent whether that amendment has actually been filed and is effective, and update the status lines in `WHITEPAPER.md`, `TOKENOMICS.md`, `PROTOCOL.md`, `MINT.md`, and the site accordingly.
- [x] ~~**Fix the Formspree placeholder**~~ **Resolved.** `apply.html` posts to a real Formspree endpoint.
- [x] ~~**Decide the whitepaper's permanent home.**~~ **Resolved.** The whitepaper is now a page in the site itself (`website/whitepaper.html`), not an external link.
- [ ] Do one final proofread pass across the site now that the domain is real — addresses, entity name, ticker should already all read "ACT" / "Aretia Finance LLC" correctly from the 4 Sept rename pass, but worth a last check since this is the point where it becomes genuinely public.

## 7. Deploy and verify against the real domain

- [x] Push to the main branch; confirm the host's auto-deploy actually fires and the live domain updates. Confirmed repeatedly through Sept 2026 (dozens of pushes, each one live within moments).
- [ ] On the real, live URL (not localhost), check: the nav and all anchor links work, the Buy ACT widget loads (it depends on an external script, `terminal.jup.ag`, which needs real internet access — this will behave differently on a real host than in any sandboxed preview), and the `#verify` section actually returns live checks against mainnet. Not yet specifically re-checked since the recent landing-page redesign work — worth a pass before calling this done.
- [ ] Check the mobile view — nothing in this project has been tested on a real phone yet, only viewport emulation.

## 8. Once live — close the loop on the "unverified token" problem

- [ ] Claim a real social presence (at minimum an X/Twitter account) under the current name now that there's a real domain to link from it — this also prevents someone else from squatting the handle once the project has any public footprint.
- [ ] Submit the live domain link to RugCheck's token description field and to Solscan's token-info submission process, specifically linking to `/#verify` and the whitepaper — this is the practical mitigation for the "missing on-chain metadata" problem confirmed permanent in `MINT.md`: the token can't carry a name on-chain anymore, but every place that shows it as "unverified" can at least link somewhere that proves the real story.

---

*This is a sequencing document, not a legal or financial one — none of the entity-name, tax, or securities questions elsewhere in this repo are resolved by completing this checklist. See `WHITEPAPER.md` §12 for those.*
