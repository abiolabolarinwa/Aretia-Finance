/* global process */
// Writes a VERIFIED Solana mainnet program id into the site and updates the gate tests that pin it as null. It touches only source files
// and holds no key. Run it ONLY after `curve-solana-mainnet.mjs verify` (or `pool-solana-mainnet.mjs verify`) printed "Verified".
//
//   node scripts/wire-solana-mainnet-id.mjs curve --address CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu --i-ran-verify
//   node scripts/wire-solana-mainnet-id.mjs pool  --address <the mainnet Aretia Pool id>                  --i-ran-verify
//
// Then: npm test, and commit. Setting the id makes the card live as soon as the site is deployed with its flag on
// (the curve flag PUBLIC_CURVE_ENABLED is already on in production), so rehearse with a very small curve straight after.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scripts');
const what = process.argv[2];
const i = process.argv.indexOf('--address');
const address = i === -1 ? undefined : process.argv[i + 1];
const fail = (m) => {
  console.error(`Stop: ${m}`);
  process.exit(1);
};
if (!['curve', 'pool'].includes(what)) fail('usage: wire-solana-mainnet-id.mjs curve|pool --address <program id> --i-ran-verify');
if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) fail('--address must be a Solana address.');
if (!process.argv.includes('--i-ran-verify')) fail('run the verify script on the deployed program first, then add --i-ran-verify.');

/** Each edit: [file, exact old text, new text]. All are replaced or the whole run stops before writing anything. */
const edits =
  what === 'curve'
    ? [
        ['walletCurveCore.ts', 'export const CURVE_PROGRAM_ID_MAINNET: string | null = null;', 'export const CURVE_PROGRAM_ID_MAINNET: string | null = CURVE_PROGRAM_ID_MAINNET_PLANNED;'],
        ['walletCurveGate.test.ts', '    expect(CURVE_PROGRAM_ID_MAINNET).toBeNull();', '    expect(CURVE_PROGRAM_ID_MAINNET).toBe(CURVE_PROGRAM_ID_MAINNET_PLANNED);'],
        ['walletCurveCore.test.ts', "    expect(CURVE_PROGRAM_ID_MAINNET).toBeNull();\n    expect(curveProgramFor('mainnet')).toBeNull();", "    expect(CURVE_PROGRAM_ID_MAINNET).toBe(CURVE_PROGRAM_ID_MAINNET_PLANNED);\n    expect(curveProgramFor('mainnet')).toBe(CURVE_PROGRAM_ID_MAINNET_PLANNED);"],
      ]
    : [
        ['walletAretiaPoolCore.ts', 'export const ARETIA_POOL_PROGRAM_ID_MAINNET: string | null = null;', `export const ARETIA_POOL_PROGRAM_ID_MAINNET: string | null = '${address}';`],
        ['walletAretiaPoolGate.test.ts', '    expect(ARETIA_POOL_PROGRAM_ID_MAINNET).toBeNull();', `    expect(ARETIA_POOL_PROGRAM_ID_MAINNET).toBe('${address}');`],
        ['walletAretiaPoolCore.test.ts', "    expect(ARETIA_POOL_PROGRAM_ID_MAINNET).toBeNull();\n    expect(aretiaPoolProgramFor('mainnet')).toBeNull();", `    expect(ARETIA_POOL_PROGRAM_ID_MAINNET).toBe('${address}');\n    expect(aretiaPoolProgramFor('mainnet')).toBe('${address}');`],
      ];

if (what === 'curve') {
  const core = readFileSync(join(src, 'walletCurveCore.ts'), 'utf8');
  const planned = /CURVE_PROGRAM_ID_MAINNET_PLANNED = '([^']+)'/.exec(core)?.[1];
  if (planned !== address) fail(`the committed build is made for ${planned}; ${address} is a different id, so the build would not work with it.`);
}
const next = edits.map(([file, from, to]) => {
  const text = readFileSync(join(src, file), 'utf8').replace(/\r\n/g, '\n');
  if (text.split(from).length !== 2) fail(`${file}: expected exactly one place with the text to replace; the code has changed, edit by hand (docs/MAINNET_GO_LIVE.md).`);
  return [file, text.replace(from, to)];
});
for (const [file, text] of next) {
  writeFileSync(join(src, file), text);
  console.log(`  updated ${file}`);
}
console.log('Done. Now run `npm test` in website/ and commit.');
