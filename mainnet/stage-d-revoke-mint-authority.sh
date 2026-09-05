#!/bin/bash
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

MINT_ADDRESS="BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT"
DEPLOYER_KEY="$HOME/aretia-mainnet/mainnet-deployer.json"

solana config set --url https://solana-rpc.publicnode.com > /dev/null
solana config set --keypair "$DEPLOYER_KEY" > /dev/null

echo "== Revoking mint authority permanently =="
spl-token authorize "$MINT_ADDRESS" mint --disable

echo ""
echo "== Final verification =="
spl-token display "$MINT_ADDRESS"
