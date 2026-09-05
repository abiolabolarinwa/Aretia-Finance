#!/bin/bash
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

DECIMALS=9
FEE_BPS=410
MAX_FEE_UI=100000000
TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
DEPLOYER_KEY="$HOME/aretia-mainnet/mainnet-deployer.json"

solana config set --url https://api.mainnet-beta.solana.com > /dev/null
solana config set --keypair "$DEPLOYER_KEY" > /dev/null

echo "== Deployer balance =="
solana balance

echo ""
echo "== Creating ACC mint on MAINNET (Token-2022, 4.1% transfer-fee extension) =="
CREATE_OUTPUT=$(spl-token create-token \
  --program-id "$TOKEN_2022_PROGRAM" \
  --decimals "$DECIMALS" \
  --transfer-fee-basis-points "$FEE_BPS" \
  --transfer-fee-maximum-fee "$MAX_FEE_UI")
echo "$CREATE_OUTPUT"

MINT_ADDRESS=$(echo "$CREATE_OUTPUT" | grep -oP '(?<=Creating token )\S+')
echo ""
echo "MINT ADDRESS: $MINT_ADDRESS"
echo "$MINT_ADDRESS" > "$HOME/aretia-mainnet/mint-address.txt"

echo ""
echo "== Verifying mint on-chain =="
spl-token display "$MINT_ADDRESS"
