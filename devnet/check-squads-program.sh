#!/bin/bash
echo "--- getHealth ---"
curl -s -X POST https://api.devnet.solana.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
echo ""
echo "--- getAccountInfo for Squads V4 program ---"
curl -s -X POST https://api.devnet.solana.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",{"encoding":"base64"}]}'
echo ""
