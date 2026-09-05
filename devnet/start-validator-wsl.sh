#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
mkdir -p "$HOME/aretia-ledger"
exec solana-test-validator --ledger "$HOME/aretia-ledger" --reset
