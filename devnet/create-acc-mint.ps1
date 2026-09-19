# =============================================================================
# ACC (Aretia Climate Coin) — Devnet Token-2022 Mint Setup
# =============================================================================
# DEVNET ONLY. Every keypair this script touches is throwaway test material —
# none of it should ever be reused on mainnet. Run this after the devnet
# faucet rate limit has reset and `solana balance` shows > 0 SOL.
#
# IMPORTANT — what this script does and doesn't do:
#   The Token-2022 transfer-fee extension supports exactly ONE fee, withheld
#   automatically on every transfer and accumulated until someone with the
#   withdraw authority harvests it. It does NOT natively split that fee three
#   ways into treasury/liquidity/burn — that split (2%/1%/1% from the
#   tokenomics doc) is a TREASURY OPERATIONS process: the withdraw authority
#   (the Squads multisig, on mainnet) periodically harvests the accumulated
#   fee, then executes three separate, multisig-approved transactions to
#   route it. Automating that three-way split on-chain would require a custom
#   program (Anchor/Rust) — out of scope for this CLI-only devnet pass.
#   This script sets up and demonstrates the single 4% withheld fee, plus the
#   harvest step, so you can see the mechanism working end to end.
# =============================================================================

$ErrorActionPreference = "Stop"
$env:PATH = "$env:USERPROFILE\.local\share\solana\install\active_release\bin;$env:PATH"

$DevnetDir   = $PSScriptRoot
$DeployerKey = "$DevnetDir\deployer-keypair.json"
$RecipientKey = "$DevnetDir\test-recipient-keypair.json"

$Decimals   = 9
$TotalSupply = 100000000                # 100,000,000 ACC — locked parameter
$FeeBps     = 410                       # 4.10% total transfer fee: 2% treasury + 1% liquidity + 1% burn + 0.1% management (draft — tune before mainnet)
$MaxFee     = 100000000 * [math]::Pow(10, $Decimals)   # effectively uncapped for any realistic single trade
$TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

Write-Host "== Sanity checks ==" -ForegroundColor Cyan
solana config set --url devnet | Out-Null
solana config set --keypair "$DeployerKey" | Out-Null
$balance = solana balance
Write-Host "Deployer balance: $balance"
if ($balance -match "^0 SOL") {
    Write-Host "Deployer has 0 SOL — fund it first (solana airdrop 2) before running this script." -ForegroundColor Red
    exit 1
}

# -----------------------------------------------------------------------------
# 1. Create the ACC mint with the transfer-fee extension
#    Fee authority + withdraw authority = deployer key for this devnet test.
#    On mainnet, both become the Squads treasury multisig — never a single key.
# -----------------------------------------------------------------------------
Write-Host "`n== Creating ACC mint (Token-2022, transfer-fee extension) ==" -ForegroundColor Cyan
$createOutput = spl-token create-token `
    --program-id $TOKEN_2022_PROGRAM `
    --decimals $Decimals `
    --transfer-fee $FeeBps $MaxFee `
    --transfer-fee-authority "$DeployerKey" `
    --withdraw-withheld-authority "$DeployerKey"
Write-Host $createOutput

$mintAddress = ($createOutput | Select-String -Pattern "Creating token\s+(\S+)").Matches.Groups[1].Value
if (-not $mintAddress) {
    Write-Host "Could not parse mint address from output above — check manually." -ForegroundColor Red
    exit 1
}
Write-Host "ACC mint address: $mintAddress" -ForegroundColor Green
$mintAddress | Out-File -FilePath "$DevnetDir\mint-address.txt" -Encoding utf8

# -----------------------------------------------------------------------------
# 2. Create the deployer's associated token account and mint the fixed supply
# -----------------------------------------------------------------------------
Write-Host "`n== Minting fixed supply: $TotalSupply ACC ==" -ForegroundColor Cyan
spl-token create-account $mintAddress
spl-token mint $mintAddress $TotalSupply

# -----------------------------------------------------------------------------
# 3. Lock the supply — revoke mint authority permanently (locked parameter)
#    Freeze authority is already None by default (never set above).
# -----------------------------------------------------------------------------
Write-Host "`n== Revoking mint authority (fixed supply, permanent) ==" -ForegroundColor Cyan
spl-token authorize $mintAddress mint --disable

# -----------------------------------------------------------------------------
# 4. Test the fee mechanism: create a recipient, send a test transfer, confirm
#    the fee was withheld, then harvest it back to the fee authority account.
# -----------------------------------------------------------------------------
Write-Host "`n== Setting up test recipient wallet ==" -ForegroundColor Cyan
if (-not (Test-Path $RecipientKey)) {
    solana-keygen new --outfile $RecipientKey --no-bip39-passphrase --force
}
$recipientAddress = solana-keygen pubkey $RecipientKey
Write-Host "Test recipient: $recipientAddress"

Write-Host "`n== Sending test transfer of 1,000 ACC (fee should withhold ~41 ACC at 4.1%) ==" -ForegroundColor Cyan
spl-token transfer $mintAddress 1000 $recipientAddress --fund-recipient --allow-unfunded-recipient

Write-Host "`n== Checking recipient balance (should show ~959 ACC received) ==" -ForegroundColor Cyan
spl-token balance $mintAddress --owner $recipientAddress

Write-Host "`n== Harvesting withheld fees back to the deployer (fee authority) account ==" -ForegroundColor Cyan
spl-token withdraw-withheld-tokens $mintAddress --include-mint

Write-Host "`n== Done. Deployer's post-harvest balance ==" -ForegroundColor Cyan
spl-token balance $mintAddress

Write-Host "`nMint address saved to: $DevnetDir\mint-address.txt" -ForegroundColor Green
Write-Host "Reminder: the harvested ~41 ACC above is the FULL 4.1% fee, undivided." -ForegroundColor Yellow
Write-Host "Splitting it into 2% treasury / 1% liquidity / 1% burn / 0.1% management is a" -ForegroundColor Yellow
Write-Host "manual multisig-approved step on top of this harvest, per the tokenomics doc." -ForegroundColor Yellow
Write-Host "The 0.1% management share must be tracked as its own disclosed line on the" -ForegroundColor Yellow
Write-Host "transparency dashboard - never merged into the project-funding total." -ForegroundColor Yellow
