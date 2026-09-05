#!/bin/bash
set -e
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

MINT_ADDRESS="BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT"
TREASURY_VAULT="3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg"
TOTAL_SUPPLY=100000000
DEPLOYER_KEY="$HOME/aretia-mainnet/mainnet-deployer.json"

solana config set --keypair "$DEPLOYER_KEY" > /dev/null

echo "== Creating the treasury vault's associated token account for ACC =="
CREATE_ACCT_OUTPUT=$(spl-token create-account "$MINT_ADDRESS" --owner "$TREASURY_VAULT" --fee-payer "$DEPLOYER_KEY")
echo "$CREATE_ACCT_OUTPUT"
TREASURY_ATA=$(echo "$CREATE_ACCT_OUTPUT" | grep -oP '(?<=Creating account )\S+')
echo ""
echo "TREASURY ATA: $TREASURY_ATA"
echo "$TREASURY_ATA" > "$HOME/aretia-mainnet/treasury-ata.txt"

echo ""
echo "== Minting fixed supply ($TOTAL_SUPPLY ACC) directly to the treasury vault =="
spl-token mint "$MINT_ADDRESS" "$TOTAL_SUPPLY" "$TREASURY_ATA"

echo ""
echo "== Verifying: treasury ATA balance =="
spl-token balance "$MINT_ADDRESS" --owner "$TREASURY_VAULT"

echo ""
echo "== Verifying: mint supply matches exactly =="
spl-token display "$MINT_ADDRESS"
