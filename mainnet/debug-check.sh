#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
MINT_ADDRESS="BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT"
DEPLOYER_KEY="$HOME/aretia-mainnet/mainnet-deployer.json"
solana config set --keypair "$DEPLOYER_KEY" > /dev/null

echo "== solana config =="
solana config get

echo ""
echo "== spl-token display (plain) =="
spl-token display "$MINT_ADDRESS"

echo ""
echo "== spl-token authorize --help (transfer-fee-config section) =="
spl-token authorize --help 2>&1 | head -60
