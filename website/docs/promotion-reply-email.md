# Promotion: replying to a request

A request arrives by Formspree (subject "Request: Featured launch" or "Request: Verified by Aretia"). Nothing is charged by the forms. Payment details go out only in this reply, after the request is approved. Do not put these addresses on the site or in the forms: a public pay-to address invites payment before approval and copycat pages.

## Before replying

- Featured: read the project link; run `node scripts/verify-token.mjs <chain> <address>` and look at the pool. Say no to anything Aretia could not stand behind. Featured is a placement, not an endorsement.
- Verification: it is not for sale. Run the four checks in `docs/verified-badge.md` first and reply with what was found, including a failure.

## Featured: reply to send once approved

> Subject: Your featured place on Aretia
>
> Hi,
>
> We have read your request for **TOKEN (chain)** and we are happy to feature it inside Aretia Wallet (the Markets list and the Launch page), marked "Featured", for these dates: **FROM to TO**.
>
> The price is **$AMOUNT** (promotion starts from $100). You can pay in any one of these. Tell us which you will use before you send anything, so we can confirm it:
>
> - **USDC on Solana** to `2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2`
> - **USDT on Ethereum** to `0xeb8725e16e504036c2166aa47804d88ecc4d0945`
> - **USDT on BNB Chain** to `0xeb8725e16e504036c2166aa47804d88ecc4d0945` (the same address, but send on BNB Chain, not Ethereum)
>
> Send the exact amount, on the network and in the token named above, and reply with the transaction link. Your place goes live on the first day once we see the payment. A payment sent on a different network or in a different token may not be recoverable.
>
> Featured is a placement. It is not a rating, a check or an endorsement by Aretia, and the card says so.
>
> Aretia Finance

## If we cannot feature it

> Thanks for asking. We are not able to feature this token: we do not feature anything we could not stand behind if someone asked us about it. Nothing has been charged.

## After payment

1. Open the transaction on the explorer and check the network, token, amount and recipient.
2. Add the entry to `website/src/data/featured.ts` (format in the file), push, merge, and confirm it shows after the deploy.
3. Keep the transaction link with the request. The revenue report totals the fee addresses by deposit and does not tag which payment was a promotion, so this link is the only match between a payment and a request.

## Decimals reminder

USDT has 18 decimals on BNB Chain and 6 on Ethereum. Check the amount received, not the number of digits.
