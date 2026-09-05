# Website Go-Live Checklist — Domain to Deployed

**Scope note:** this checklist covers *the website going live at a real, public URL* — not the token trading, liquidity, or audit workstreams tracked in `TOKENOMICS.md` §07 and `MINT.md`. Those are separate and don't block this. A live website with no liquidity yet is an accurate, honest state (and matches everything the site itself already says); a live token no one can actually trade with a broken or missing website is not.

Status: drafted 4 Sept 2026. Step 1 complete. Steps 2 through 8 not yet executed.

---

## 1. Register the domain

- [x] **`aretiafinance.org`** registered through GoDaddy, 4 Sept 2026. Matches the current entity name (Aretia Finance LLC) and avoids "coin," consistent with the 4 Sept rename.
- [ ] DNS not yet pointed anywhere — that happens after hosting is chosen (Step 4). Nothing loads at this domain yet; registering it is not the same as the site being reachable there.

## 2. Fix the git repository

- [x] Old repo, rooted at the entire Windows user folder with a placeholder remote, abandoned. A fresh git repository was initialized scoped to just the project folder, 5 Sept 2026.
- [x] Project folder renamed from `aretia-climate-coin` to `aretia-finance`, matching the entity name and domain.
- [x] Confirmed no unrelated personal files swept in: 43 files staged and committed, all project files. A repo-wide `.gitignore` was added excluding `node_modules/`, the local Solana test-validator ledger, and, as a safety net, any keypair-shaped `.json` file anywhere in the repo (a real disposable devnet keypair on disk was confirmed correctly excluded before the first commit, not just assumed).

## 3. Decide the GitHub setup and push the code

- [x] Created `abiolabolarinwa/Aretia-Finance` on GitHub, set to **Private** — the right call given `LIQUIDITY_ONE_PAGER.md`, `FOUNDATION_BRIEF.md`, `ATTORNEY_BRIEF.md`, and `ENTITY_RENAME_BRIEF.md` all contain internal or not-yet-reviewed content.
- [x] Remote set, initial commit pushed, 5 Sept 2026. `main` branch tracking `origin/main`.

## 4. Choose hosting and connect it to the repo

- [ ] This site is fully static (HTML/CSS/JS, no backend, no database) — any static host works. Vercel, Netlify, and Cloudflare Pages are the standard free-tier choices; any of the three is a fine pick, and all three support "push to GitHub, auto-deploy" out of the box.
- [ ] Connect the chosen host to the GitHub repo from Step 3.
- [ ] Confirm the host's default preview URL (e.g., `something.vercel.app`) actually builds and loads correctly before touching DNS — this catches deployment problems while nothing public depends on them yet.

## 5. Point the domain at the host

- [ ] In the host's dashboard, add the custom domain from Step 1.
- [ ] Update the domain's DNS at GoDaddy per the host's instructions (usually either nameserver delegation or a specific CNAME/A record) — every major host has a documented flow for this.
- [ ] Wait for DNS propagation (can take minutes to a couple of hours) and confirm the real domain loads the site with a valid HTTPS certificate (all three hosts above issue this automatically).

## 6. Pre-launch content pass — fix what's still placeholder or unresolved

- [ ] **Confirm the Delaware entity amendment.** Every document currently says "Aretia Finance LLC — Delaware amendment in progress." Before the site is genuinely public, confirm with your registered agent whether that amendment has actually been filed and is effective, and update the status lines in `WHITEPAPER.md`, `TOKENOMICS.md`, `PROTOCOL.md`, `MINT.md`, and the site accordingly.
- [ ] **Fix the Formspree placeholder** in `apply.html` — it still has a literal `YOUR_FORM_ID` placeholder, so the project-funding application form does not currently deliver submissions anywhere. Needs a real Formspree (or equivalent) endpoint before the "Apply for Funding" page goes live.
- [ ] **Decide the whitepaper's permanent home.** It currently lives at a private Claude Artifact URL (`claude.ai/code/artifact/...`). That's fine for internal use, but a live public site pointing its primary CTA at a Claude-branded link is a weaker look than hosting the whitepaper at `aretiafinance.org/whitepaper` now that the domain exists. Consider exporting it as a page in the site itself rather than linking out.
- [ ] Do one final proofread pass across the site now that the domain is real — addresses, entity name, ticker should already all read "ACT" / "Aretia Finance LLC" correctly from the 4 Sept rename pass, but worth a last check since this is the point where it becomes genuinely public.

## 7. Deploy and verify against the real domain

- [ ] Push to the main branch; confirm the host's auto-deploy actually fires and the live domain updates.
- [ ] On the real, live URL (not localhost), check: the nav and all anchor links work, the Buy ACT widget loads (it depends on an external script, `terminal.jup.ag`, which needs real internet access — this will behave differently on a real host than in any sandboxed preview), and the `#verify` section actually returns live checks against mainnet.
- [ ] Check the mobile view — nothing in this project has been tested on a real phone yet, only viewport emulation.

## 8. Once live — close the loop on the "unverified token" problem

- [ ] Claim a real social presence (at minimum an X/Twitter account) under the current name now that there's a real domain to link from it — this also prevents someone else from squatting the handle once the project has any public footprint.
- [ ] Submit the live domain link to RugCheck's token description field and to Solscan's token-info submission process, specifically linking to `/#verify` and the whitepaper — this is the practical mitigation for the "missing on-chain metadata" problem confirmed permanent in `MINT.md`: the token can't carry a name on-chain anymore, but every place that shows it as "unverified" can at least link somewhere that proves the real story.

---

*This is a sequencing document, not a legal or financial one — none of the entity-name, tax, or securities questions elsewhere in this repo are resolved by completing this checklist. See `ENTITY_RENAME_BRIEF.md`, `FOUNDATION_BRIEF.md`, and `WHITEPAPER.md` §12 for those.*
