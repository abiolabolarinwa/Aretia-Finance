// Sepolia: adds liquidity on the real Uniswap V2 router for the mock pair, whitelists the router and places two buys for the EVM keeper. Test network only; needs the artifacts and the outputs of sepolia.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, JsonRpcProvider, Wallet, parseUnits } from 'ethers';
const p = new JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
const w = new Wallet(readFileSync('evm-key.txt', 'utf8'), p);
const art = JSON.parse(readFileSync('artifacts.json', 'utf8'));
const run = JSON.parse(readFileSync('sepolia-run.json', 'utf8'));
const ROUTER = '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3';
const router = new Contract(ROUTER, ['function factory() view returns (address)', 'function WETH() view returns (address)', 'function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)', 'function getAmountsOut(uint256,address[]) view returns (uint256[])'], w);
console.log('router factory', await router.factory(), 'weth', await router.WETH());
const tok = new Contract(run.token, ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], w);
const q = new Contract(run.MockQuote, art.MockQuote.abi, w);
const orders = new Contract(run.AretiaOrders, art.AretiaOrders.abi, w);
await (await q.mint(w.address, parseUnits('5000', 6))).wait();
await (await tok.approve(ROUTER, parseUnits('3000000', 18))).wait();
await (await q.approve(ROUTER, parseUnits('3000', 6))).wait();
const dl = Math.floor(Date.now() / 1000) + 3600;
await (await router.addLiquidity(run.token, run.MockQuote, parseUnits('2000000', 18), parseUnits('2000', 6), 0, 0, w.address, dl)).wait();
console.log('pool out for 98.5 quote:', (await router.getAmountsOut(parseUnits('98.5', 6), [run.MockQuote, run.token]))[1]);
await (await orders.setVenue(ROUTER, true)).wait();
await (await q.approve(run.AretiaOrders, parseUnits('3000', 6))).wait();
// two buys: 200 quote (should fill in slices) and 100 quote; the limits sit under what the pool gives.
const ids = [];
for (const [amt, min] of [['200', '150000'], ['100', '80000']]) {
  const rc = await (await orders.createOrder(run.token, run.MockQuote, true, parseUnits(amt, 6), parseUnits(min, 18))).wait();
  ids.push(String(rc.logs.map((l) => { try { return orders.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'OrderCreated').args.id));
}
const block = await p.getBlockNumber();
writeFileSync('uni-run.json', JSON.stringify({ router: ROUTER, orders: run.AretiaOrders, ids, blockAfter: block }, null, 2));
console.log('orders', ids, 'block', block);
