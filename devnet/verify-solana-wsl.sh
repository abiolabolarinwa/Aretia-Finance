#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo "HOME=$HOME"
solana --version
solana-keygen --version
spl-token --version
