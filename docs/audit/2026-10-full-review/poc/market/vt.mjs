import { readSolanaMint, checkSolana, checkEvm } from '../../../../../website/scripts/verifyTokenCore.mjs';
const T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function mint(exts){ // exts: [type, len]
  const body=[]; for(const [t,l] of exts){ body.push(t&255,t>>8,l&255,l>>8, ...new Array(l).fill(7)); }
  const d=new Uint8Array(166+body.length); d[45]=1; d[44]=6; d[165]=1; d.set(body,166); return d; }
for (const [name,e] of [['pausable(26)',[[26,65]]],['scaledUi(25)',[[25,56]]],['mintClose(3)',[[3,32]]],['confFee(16)',[[16,100]]],['confMintBurn(24)',[[24,100]]],['permDelegate(12)',[[12,32]]]]) {
  const r=checkSolana(readSolanaMint(T22,mint(e))); console.log(name, r.supplyFixed.pass, r.powersGivenUp.pass);
}
// EIP-1967 proxy runtime (OZ TransparentUpgradeableProxy-like minimal) -> no selectors
const proxy='0x363d3d373d3d3d363d73'+'11'.repeat(20)+'5af43d82803e903d91602b57fd5bf3';
const r=checkEvm(proxy,'1000','1000'); console.log('EIP1167 proxy', r.supplyFixed.pass, r.powersGivenUp.pass);
