import io


def edit(p, pairs):
    s = io.open(p, encoding='utf-8').read()
    for o, n in pairs:
        assert o in s, (p, o[:70])
        s = s.replace(o, n, 1)
    io.open(p, 'w', encoding='utf-8').write(s)


edit('api/_swingsStatus.ts', [
    (" * SWINGS_EVM_CHAINS (comma-separated, for example \"base,polygon\") is the operator's explicit switch for\n * each EVM chain. Aretia's own router needs no third-party key. ZEROX_API_KEY only enables the optional,\n * non-core 0x benchmarking provider. Unlisted chains stay off.",
     " * EVM networks are ON by default. SWINGS_EVM_CHAINS is the operator's switch: when it is set it is an allow-list\n * (comma-separated, for example \"base,polygon\"; the word \"none\" turns every EVM network off) and any chain not\n * listed is off. Aretia's own router needs no third-party key. ZEROX_API_KEY only enables the optional, non-core 0x\n * benchmarking provider."),
    ("const EVM_CHAINS = ['ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche'];",
     """const EVM_CHAINS = ['ethereum', 'bnb', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche'];

/**
 * The EVM networks that are on. Unset means all of them. Set means exactly the ones listed ("none" or any list that
 * names no real chain means none), so the operator can switch any network off without a deploy.
 */
export function evmChainsFromEnv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [...EVM_CHAINS];
  return value.split(',').map((c) => c.trim().toLowerCase()).filter((c) => EVM_CHAINS.includes(c));
}"""),
    ("  const chains = (env.SWINGS_EVM_CHAINS ?? '').split(',').map((c) => c.trim().toLowerCase()).filter((c) => EVM_CHAINS.includes(c));", "  const chains = evmChainsFromEnv(env.SWINGS_EVM_CHAINS);"),
])
edit('api/_swingsQuote.ts', [
    ("import { overLimit, PUBLIC_FALLBACK_RPC, type ProxyEnv } from './_rpcProxy.js';", "import { overLimit, PUBLIC_FALLBACK_RPC, type ProxyEnv } from './_rpcProxy.js';\nimport { evmChainsFromEnv } from './_swingsStatus.js';"),
    ("      const enabled = (input.env.SWINGS_EVM_CHAINS ?? '').split(',').map((c) => c.trim().toLowerCase());", "      const enabled = evmChainsFromEnv(input.env.SWINGS_EVM_CHAINS);"),
])
edit('src/swings/runtime.ts', [
    (" * it in SWINGS_EVM_CHAINS. Aretia's own EVM router needs no third-party key, so the list alone decides.", " * the server lists it. The server lists every EVM network unless the operator narrows the list with SWINGS_EVM_CHAINS.\n * Aretia's own EVM router needs no third-party key. If the status cannot be read, EVM stays off."),
])
edit('src/scripts/walletSwings.ts', [
    ("isChainEnabled(id) ? ' · Enabled' : ' · Not enabled yet'", "isChainEnabled(id) ? ' · Enabled' : runtime.loaded ? ' · Off' : ' · Checking…'"),
    ("swaps are not enabled yet. Aretia Swings only turns a network on when quotes, simulation, signing and fee settings all work end to end there. Nothing on this network can be traded from this page today.", "swaps are switched off at the moment, either by the operator or because the page could not reach its settings. Nothing on this network can be traded from this page right now. Reload to check again."),
    ("import { isCanaryAllowed, isChainEnabled, loadRuntime } from '../swings/runtime.js';", "import { isCanaryAllowed, isChainEnabled, loadRuntime, runtime } from '../swings/runtime.js';"),
])
print('ok')
