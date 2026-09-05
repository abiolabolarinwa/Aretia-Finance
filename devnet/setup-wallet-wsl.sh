#!/bin/bash
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

solana config set --url http://127.0.0.1:8899 > /dev/null

if [ ! -f "$HOME/aretia-deployer.json" ]; then
  solana-keygen new --outfile "$HOME/aretia-deployer.json" --no-bip39-passphrase --force
fi
solana config set --keypair "$HOME/aretia-deployer.json" > /dev/null

echo "Deployer address:"
solana address

echo "Airdropping 100 SOL (local validator, no rate limit)..."
solana airdrop 100

echo "Balance:"
solana balance
