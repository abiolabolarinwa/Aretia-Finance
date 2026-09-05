#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana airdrop 2 4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG --url https://api.devnet.solana.com
solana balance 4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG --url https://api.devnet.solana.com
