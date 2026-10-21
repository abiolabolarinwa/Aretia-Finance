// F-02: a fee recipient that reverts on receipt (what an EIP-7702 delegation on the fee EOA can install) freezes every buy and sell.
import * as H from './harness.mjs';
const E = 10n ** 18n;
const s = await H.setup(9);
const CR = '0x' + 'c9'.repeat(20), B = '0x' + 'b9'.repeat(20);
await H.fund(CR, 100n * E); await H.fund(B, 100n * E);
const token = (await H.call(CR, s.factory, H.facAbi, 'create', ['F', 'F', 18, 1_000_000_000n * E])).out;
await H.call(CR, token, H.tokAbi, 'approve', [s.curve, 1_000_000_000n * E]);
await H.call(CR, s.curve, H.curveAbi, 'createCurve', [token, 1n, 1_000_000_000n * E, 5n * E, 0n]);
let r = await H.call(B, s.curve, H.curveAbi, 'buy', [token, 0n], 1n * E); console.log('buy before', r.ok);
// emulate 7702 delegation to code that reverts: put INVALID opcode at the fee recipient
await H.vm.stateManager.putContractCode(H.addr(s.FEE), Uint8Array.from([0xfe]));
r = await H.call(B, s.curve, H.curveAbi, 'buy', [token, 0n], 1n * E); console.log('buy after', r.ok, r.reason);
await H.call(B, token, H.tokAbi, 'approve', [s.curve, 10n ** 24n]);
r = await H.call(B, s.curve, H.curveAbi, 'sell', [token, 10n ** 24n, 0n]); console.log('sell after', r.ok, r.reason);
