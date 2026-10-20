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

MINT_ADDRESS="BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT"
TREASURY_VAULT="3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg"
DEPLOYER_KEY="$HOME/aretia-mainnet/mainnet-deployer.json"

solana config set --url https://solana-rpc.publicnode.com > /dev/null
solana config set --keypair "$DEPLOYER_KEY" > /dev/null
solana config get

echo "== Transferring transfer-fee-config authority to the treasury vault =="
spl-token authorize "$MINT_ADDRESS" transfer-fee-config "$TREASURY_VAULT"

echo ""
echo "== Transferring withheld-withdraw authority to the treasury vault =="
spl-token authorize "$MINT_ADDRESS" withheld-withdraw "$TREASURY_VAULT"

echo ""
echo "== Verifying: both authorities now show the treasury vault =="
spl-token display "$MINT_ADDRESS"
