#!/bin/bash
# =============================================================================
# ACC (Aretia Climate Coin) — Local Validator Token-2022 Mint Setup (WSL)
# =============================================================================
# Runs against the LOCAL test validator (http://127.0.0.1:8899) inside WSL.
# Every keypair here is throwaway test material — never reused on mainnet.
#
# Same caveat as the Windows version: the Token-2022 transfer-fee extension
# withholds a single combined fee (4.1%). Splitting it into the 2%/1%/1%/0.1%
# treasury/liquidity/burn/management allocation from the tokenomics doc is a
# manual, multisig-approved step after each harvest — not automated on-chain
# here without a custom program.
# =============================================================================
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

DECIMALS=9
TOTAL_SUPPLY=100000000
FEE_BPS=410
MAX_FEE_UI=100000000   # UI-amount cap (=total supply), effectively uncapped for any realistic single trade
TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
DEPLOYER_KEY="$HOME/aretia-deployer.json"
RECIPIENT_KEY="$HOME/aretia-test-recipient.json"

echo "== Sanity checks =="
solana config set --url http://127.0.0.1:8899 > /dev/null
solana config set --keypair "$DEPLOYER_KEY" > /dev/null
BALANCE=$(solana balance)
echo "Deployer balance: $BALANCE"

echo ""
echo "== Creating ACC mint (Token-2022, transfer-fee extension) =="
# Transfer-fee and withdraw-withheld authority default to the mint authority
# (the deployer keypair here); on mainnet the mint authority itself becomes
# the Squads treasury multisig, so this still ends up multisig-controlled.
CREATE_OUTPUT=$(spl-token create-token \
  --program-id "$TOKEN_2022_PROGRAM" \
  --decimals "$DECIMALS" \
  --transfer-fee-basis-points "$FEE_BPS" \
  --transfer-fee-maximum-fee "$MAX_FEE_UI")
echo "$CREATE_OUTPUT"

MINT_ADDRESS=$(echo "$CREATE_OUTPUT" | grep -oP '(?<=Creating token )\S+')
echo "ACC mint address: $MINT_ADDRESS"
echo "$MINT_ADDRESS" > "$HOME/aretia-mint-address.txt"

echo ""
echo "== Minting fixed supply: $TOTAL_SUPPLY ACC =="
CREATE_ACCT_OUTPUT=$(spl-token create-account "$MINT_ADDRESS")
echo "$CREATE_ACCT_OUTPUT"
DEPLOYER_ATA=$(echo "$CREATE_ACCT_OUTPUT" | grep -oP '(?<=Creating account )\S+')
spl-token mint "$MINT_ADDRESS" "$TOTAL_SUPPLY"

echo ""
echo "== Revoking mint authority (fixed supply, permanent) =="
spl-token authorize "$MINT_ADDRESS" mint --disable

echo ""
echo "== Setting up test recipient wallet =="
if [ ! -f "$RECIPIENT_KEY" ]; then
  solana-keygen new --outfile "$RECIPIENT_KEY" --no-bip39-passphrase --force
fi
RECIPIENT_ADDRESS=$(solana-keygen pubkey "$RECIPIENT_KEY")
echo "Test recipient: $RECIPIENT_ADDRESS"

echo ""
echo "== Sending test transfer of 1,000 ACC (fee should withhold ~41 ACC at 4.1%) =="
TRANSFER_OUTPUT=$(spl-token transfer "$MINT_ADDRESS" 1000 "$RECIPIENT_ADDRESS" --fund-recipient --allow-unfunded-recipient)
echo "$TRANSFER_OUTPUT"
RECIPIENT_ATA=$(echo "$TRANSFER_OUTPUT" | grep -oP '(?<=Recipient associated token account: )\S+')

echo ""
echo "== Recipient balance (should show ~959 ACC received) =="
spl-token balance "$MINT_ADDRESS" --owner "$RECIPIENT_ADDRESS"

echo ""
echo "== Harvesting withheld fees back to the deployer (fee authority) =="
# Fee recipient = deployer's own ACC account; source = recipient's account
# where the withheld fee is currently sitting; --include-mint also sweeps
# anything that landed directly on the mint.
spl-token withdraw-withheld-tokens "$DEPLOYER_ATA" "$RECIPIENT_ATA" --include-mint

echo ""
echo "== Deployer post-harvest balance =="
spl-token balance "$MINT_ADDRESS"

echo ""
echo "Mint address saved to: $HOME/aretia-mint-address.txt"
echo "Reminder: the harvested ~41 ACC above is the FULL 4.1% fee, undivided."
echo "Splitting it into 2%/1%/1%/0.1% is a manual multisig step, per the tokenomics doc."
