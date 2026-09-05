#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
mkdir -p "$HOME/aretia-mainnet"
solana-keygen new --outfile "$HOME/aretia-mainnet/mainnet-deployer.json" --no-bip39-passphrase --force
echo "---"
solana-keygen pubkey "$HOME/aretia-mainnet/mainnet-deployer.json"
