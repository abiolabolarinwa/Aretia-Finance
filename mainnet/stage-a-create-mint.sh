#!/bin/bash
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# This script points the solana CLI at mainnet and the deployer key. Put back whatever config was there before when it ends, however it
# ends, so a later command in this shell does not run against mainnet with the deployer key by surprise.
CLI_CONFIG="$HOME/.config/solana/cli/config.yml"
SAVED_CONFIG=$(mktemp)
if [ -f "$CLI_CONFIG" ]; then cp "$CLI_CONFIG" "$SAVED_CONFIG"; HAD_CONFIG=1; else HAD_CONFIG=0; fi
restore_config() {
  if [ "$HAD_CONFIG" = 1 ]; then cp "$SAVED_CONFIG" "$CLI_CONFIG"; else rm -f "$CLI_CONFIG"; fi
  rm -f "$SAVED_CONFIG"
  echo "(solana CLI config restored)"
}
trap restore_config EXIT

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
