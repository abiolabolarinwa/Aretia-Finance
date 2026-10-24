/**
 * Evidence earned by decoders on real captured logs (see dexes.ts). Written as code, not JSON: a JSON import fails to load in the
 * server functions (Node ES modules need an import attribute for it), which took the whole function down once.
 * decode.test.ts checks this table against what the decoders achieve on fixtures/real-logs.json.
 */
export const EVIDENCE: Readonly<Record<string, string>> = {
  'uniswap-v2-ethereum': 'fixture-tested',
  'pancakeswap-v2-bnb': 'fixture-tested',
  'uniswap-v2-base': 'fixture-tested',
  'pancakeswap-v2-ethereum': 'fixture-tested',
  'pancakeswap-v2-base': 'fixture-tested',
  'sushiswap-v2-ethereum': 'fixture-tested',
  'sushiswap-v2-polygon': 'fixture-tested',
  'sushiswap-v2-base': 'fixture-tested',
  'sushiswap-v2-arbitrum': 'fixture-tested',
  'uniswap-v3-ethereum': 'fixture-tested',
  'uniswap-v3-polygon': 'fixture-tested',
  'uniswap-v3-base': 'fixture-tested',
  'uniswap-v3-arbitrum': 'fixture-tested',
  'uniswap-v3-optimism': 'fixture-tested',
  'uniswap-v3-avalanche': 'fixture-tested',
  'uniswap-v3-bnb': 'fixture-tested',
  'pancakeswap-v3-bnb': 'fixture-tested',
  'pancakeswap-v3-ethereum': 'fixture-tested',
  'pancakeswap-v3-base': 'fixture-tested',
  'pancakeswap-v3-arbitrum': 'fixture-tested',
};
