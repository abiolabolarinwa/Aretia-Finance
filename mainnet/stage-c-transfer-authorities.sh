#!/bin/bash
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

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
