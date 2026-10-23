// Sepolia run of the order contract with mocks. Needs: npm i solc@0.8.28 ethers@6.13.4; node compile.mjs <path to contracts-evm> (writes artifacts.json); EVM_KEY_FILE=<file with a funded Sepolia throwaway private key> node sepolia.mjs. Test network only.
import { readFileSync, writeFileSync } from 'node:fs';
import { ContractFactory, JsonRpcProvider, Wallet, Interface, parseUnits, parseEther } from 'ethers';
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const p = new JsonRpcProvider(RPC);
if ((await p.getNetwork()).chainId !== 11155111n) throw new Error('not Sepolia');
const w = new Wallet(readFileSync(process.env.EVM_KEY_FILE, 'utf8'), p);
const art = JSON.parse(readFileSync('artifacts.json', 'utf8'));
const log = { deployer: w.address, network: 'sepolia' };
const deploy = async (name, ...args) => { const f = new ContractFactory(art[name].abi, art[name].bytecode, w); const c = await f.deploy(...args); await c.waitForDeployment(); log[name] = await c.getAddress(); console.log(name, log[name]); return c; };
const FEE_WALLET = '0xd366cF21Ca17487fab4734A32a53c7a155D7Ec2A';
const start = await p.getBalance(w.address);
const factory = await deploy('AretiaTokenFactory', w.address, 0n);
const tx0 = await factory.create('Order Test', 'ORT', 18, parseUnits('1000000000', 18)); const r0 = await tx0.wait();
const token = r0.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.args && e.args.token)?.args.token;
log.token = token; console.log('token', token);
const quote = await deploy('MockQuote'); await (await quote.mint(w.address, parseUnits('10000', 6))).wait();
const venue = await deploy('MockOrderVenue');
const tokenC = new (await import('ethers')).Contract(token, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], w);
await (await tokenC.transfer(log.MockOrderVenue, parseUnits('1000000', 18))).wait();
const orders = await deploy('AretiaOrders', w.address, FEE_WALLET, log.AretiaTokenFactory, log.MockQuote, 58, 150, 200, 2000);
await (await orders.proveLaunchToken(token, 1)).wait();
await (await orders.setVenue(log.MockOrderVenue, true)).wait();
await (await orders.setQuote(log.MockQuote, parseUnits('50', 6))).wait();
const q = new (await import('ethers')).Contract(log.MockQuote, ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], w);
await (await q.approve(log.AretiaOrders, parseUnits('10000', 6))).wait();

// A: create then cancel
const feeBefore = await q.balanceOf(FEE_WALLET); const meBefore = await q.balanceOf(w.address);
let rc = await (await orders.createOrder(token, log.MockQuote, true, parseUnits('100', 6), parseUnits('1', 18))).wait();
const idA = rc.logs.map((l) => { try { return orders.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'OrderCreated').args.id;
await (await orders.cancel(idA)).wait();
log.cancelFee = String((await q.balanceOf(FEE_WALLET)) - feeBefore);
log.refunded = String((await q.balanceOf(w.address)) - meBefore + parseUnits('100', 6)); // net of the escrow taken
log.netChange = String((await q.balanceOf(w.address)) - meBefore);
console.log('cancel fee', log.cancelFee, 'owner net change', log.netChange);

// B: create then fill by a different keeper account
rc = await (await orders.createOrder(token, log.MockQuote, true, parseUnits('100', 6), parseUnits('1', 18))).wait();
const idB = rc.logs.map((l) => { try { return orders.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'OrderCreated').args.id;
const keeper = Wallet.createRandom().connect(p);
await (await w.sendTransaction({ to: keeper.address, value: parseEther('0.005') })).wait();
const slice = parseUnits('100', 6); const buyFee = (slice * 150n + 9999n) / 10000n; const swapIn = slice - buyFee;
const data = new Interface(art.MockOrderVenue.abi).encodeFunctionData('swap', [log.MockQuote, token, swapIn, parseUnits('2', 18), log.AretiaOrders]);
const tokBefore = await tokenC.balanceOf(w.address);
const rcf = await (await orders.connect(keeper).fill(idB, slice, log.MockOrderVenue, data)).wait();
log.fillTx = rcf.hash;
log.ownerTokensReceived = String((await tokenC.balanceOf(w.address)) - tokBefore);
log.keeperTokens = String(await tokenC.balanceOf(keeper.address));
log.buyFee = String(buyFee);
console.log('owner received', log.ownerTokensReceived, 'keeper reward', log.keeperTokens);
log.ethSpent = String(start - (await p.getBalance(w.address)));
writeFileSync('sepolia-run.json', JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
