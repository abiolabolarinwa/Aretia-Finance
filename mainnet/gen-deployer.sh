#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
mkdir -p "$HOME/aretia-mainnet"
KEY="$HOME/aretia-mainnet/mainnet-deployer.json"
# Never overwrite an existing deployer key: it may hold live authority and --force would destroy it irrecoverably.
# To really replace it, move the old file away yourself first.
if [ -e "$KEY" ]; then
  echo "Refusing to overwrite existing key at $KEY. Move it aside first if you really mean to replace it." >&2
  exit 1
fi
umask 077
solana-keygen new --outfile "$KEY" --no-bip39-passphrase
echo "---"
solana-keygen pubkey "$HOME/aretia-mainnet/mainnet-deployer.json"
