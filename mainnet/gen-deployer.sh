#!/bin/bash
# Makes a new mainnet deployer key at ~/aretia-mainnet/mainnet-deployer.json. It never replaces an existing key unless you pass
# --overwrite: overwriting a key that still holds SOL or authorities loses them for good.
#
#   ./gen-deployer.sh               make the key (stops if one is already there)
#   ./gen-deployer.sh --overwrite   replace an existing key (it asks you to type the old key's address first)
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
KEY="$HOME/aretia-mainnet/mainnet-deployer.json"
mkdir -p "$HOME/aretia-mainnet"
chmod 700 "$HOME/aretia-mainnet"
FORCE=()
if [ -e "$KEY" ]; then
  OLD=$(solana-keygen pubkey "$KEY")
  if [ "${1:-}" != "--overwrite" ]; then
    echo "Stop: $KEY already exists (address $OLD). Back it up and check its balance before replacing it; pass --overwrite to replace it." >&2
    exit 1
  fi
  read -r -p "Type the address of the key being replaced ($OLD) to confirm: " TYPED
  if [ "$TYPED" != "$OLD" ]; then
    echo "Stop: that is not the address. Nothing was changed." >&2
    exit 1
  fi
  cp -p "$KEY" "$KEY.replaced-$(date +%Y%m%d%H%M%S)"
  FORCE=(--force)
fi
(umask 077 && solana-keygen new --outfile "$KEY" --no-bip39-passphrase "${FORCE[@]}")
chmod 600 "$KEY"
echo "---"
solana-keygen pubkey "$KEY"
