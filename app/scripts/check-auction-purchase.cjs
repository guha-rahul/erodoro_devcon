/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness for VM-loaded TypeScript. */
// Offline UI and wallet-lifecycle regression checks. No real wallet or RPC writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
let slots = [], cursor = 0, events = [];
const react = { ...React, useCallback: (fn) => fn, useEffect: () => {}, useRef: () => ({ current: null }), useState: (initial) => {
  const i = cursor++;
  if (!(i in slots)) slots[i] = initial;
  return [slots[i], (value) => { slots[i] = value; events.push([i, value]); }];
} };
function load(file, mocks, expose = '') {
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8') + expose, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, Date, fetch: async () => ({ ok: true, json: async () => ({}) }),
    require: (name) => name === 'react' ? react : name in mocks ? mocks[name] : require(name) });
  return loadedModule.exports;
}
const buyer = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const now = BigInt(Math.floor(Date.now() / 1000));
const wire = { seller, claims: seller, claimId: '1', collateral: seller, strike: '34000000000', maturity: String(now + 86400n), claimAmount: '100000000', quoteToken: seller, minPremium: '10000000', nonce: '1', validFrom: '1', validUntil: String(now + 1800n), allowPartial: false, allowRollover: false, signature: '0x01' };
const series = { id: 2n, config: { collateral: seller, collateralDecimals: 8, priceDecimals: 8, maturity: BigInt(wire.maturity) } };
const auction = { id: '0x01', intentHash: '0x01', path: 'fast', state: 'FastAuction', bids: [], winner: null, filledAmount: '0', fastEndsAt: Number(now) + 1200 };
const deployment = { quote: { symbol: 'tUSDC', decimals: 6 }, contracts: { intent: seller, vault: seller }, chainName: 'Base Sepolia' };
let connected = true, allowance = 0n, reject = false, revert = false, writes = [], signedBid;
const account = () => ({ address: connected ? buyer : undefined, chainId: 84532, isConnected: connected });
const hook = load('lib/use-intent.ts', {
  wagmi: { useAccount: account, useConfig: () => ({}), useWriteContract: () => ({ writeContractAsync: async (args) => {
    writes.push(args.functionName);
    if (reject) throw new Error('User rejected request');
    return args.functionName === 'approve' ? '0x01' : '0x02';
  } }) },
  'wagmi/actions': { getAccount: account, signTypedData: async (config, args) => { signedBid = args; return '0x01'; }, readContract: async (config, args) => args.functionName === 'allowance' ? allowance : [true, ''], waitForTransactionReceipt: async (config, args) => ({ status: revert && args.hash === '0x02' ? 'reverted' : 'success' }) },
  './abis': { ErodoroIntentAbi: [], ErodoroVaultAbi: [] }, './deployment': { DEPLOYMENT: deployment }, './swap-api': { SWAP_API: '' }, './wagmi': { REQUIRED_CHAIN_ID: 84532 }, './types': {},
  './batching': { canBatchAtomically: async () => false, sendAtomicBatch: async () => '0x03' },
});
let sendState = { kind: 'idle' }, step = 'approval', settled;
const stubs = {
  'next/link': ({ children, ...props }) => React.createElement('a', props, children),
  wagmi: { useAccount: account },
  '@/lib/use-intent': { useAuction: () => ({ auction, intent: wire }), useBidder: () => ({ state: sendState, purchaseStep: step, settle: async (...args) => { settled = args; sendState = { kind: 'ok', hash: '0x02' }; step = 'complete'; return '0x02'; }, submitBid: async () => true }) },
  '@/lib/deployment': { DEPLOYMENT: deployment, txExplorer: () => 'https://sepolia.basescan.org/tx/0x02' },
  '@/lib/issuers': { assetFor: () => ({ symbol: 'tAAPLc' }) }, '@/lib/format': load('lib/format.ts', {}), '@/lib/use-now': { useNow: () => now },
  '@/lib/tx': { sendPhaseLabel: () => 'Confirming', txUrl: () => '#', addressUrl: () => '#' },
  '../megapot/InvestPremiumPanel': { InvestPremiumPanel: () => null },
};
stubs['../ui'] = load('components/ui.tsx', stubs);
for (const [file, name] of [['AuctionStatusBadge', 'AuctionStatusBadge'], ['AuctionCountdown', 'AuctionCountdown'], ['AuctionTimeline', 'AuctionTimeline'], ['BestPremiumCard', 'BestPremiumCard'], ['BidList', 'BidList'], ['Summary', 'PayoffPreview']]) stubs[`./${file}`] = { [name]: () => null };
const view = load('components/auction/LiveAuctionView.tsx', stubs, '\nexport { BuyerCard, AuctionResult, parseAmount };');
const render = () => { cursor = 0; return view.BuyerCard({ series, auctionId: '0x01', capUsd: 340 }); };
const nodes = (node) => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const button = (tree, label) => nodes(tree).find((n) => n.type === stubs['../ui'].Button && renderToStaticMarkup(React.createElement('span', null, n.props.children)).includes(label));
async function main() {
  for (const options of [{}, { allowance: 10000000n }, { reject: true }, { revert: true }]) {
    slots = []; cursor = 0; events = []; writes = [];
    allowance = options.allowance ?? 0n; reject = options.reject ?? false; revert = options.revert ?? false;
    const result = await hook.useBidder().settle(wire, 100000000n, 10000000n);
    assert.equal(Boolean(result), !reject && !revert);
    assert.equal(events.some(([i, value]) => i === 1 && value === 'complete'), !reject && !revert);
    if (!reject) assert.deepEqual(writes, allowance ? ['fillIntent'] : ['approve', 'fillIntent']);
    if (!reject && !revert) assert.equal(slots[0].kind, 'ok');
  }
  slots = []; cursor = 0; events = []; await hook.useBidder().submitBid(auction, 100000000n, 10000000n);
  assert.equal(events[0][1].kind, 'sending'); assert.equal(slots[0].kind, 'idle');
  assert.equal(signedBid.message.expiry >= BigInt(auction.fastEndsAt + 300), true);
  slots = []; let tree = render();
  const initialHtml = renderToStaticMarkup(tree);
  assert.doesNotMatch(initialHtml, /Buy now/);
  assert.match(initialHtml, /Seller minimum/);
  assert.equal(button(tree, 'Place bid').props.disabled, true);
  for (const [price, valid] of [['10', true], ['12', true], ['9', false], ['1..2', false], ['0.0000001', false]]) {
    slots[0] = price; tree = render();
    assert.equal(button(tree, 'Place bid').props.disabled, !valid, price);
  }
  wire.allowPartial = true;
  for (const [qty, valid] of [['0.5', true], ['2', false], ['1..2', false]]) {
    slots[0] = '10'; slots[1] = qty; tree = render();
    assert.equal(button(tree, 'Place bid').props.disabled, !valid, qty);
  }
  wire.allowPartial = false;
  connected = false; slots = []; tree = render(); assert.equal(button(tree, 'Place bid').props.disabled, true); connected = true;
  const end = wire.validUntil; wire.validUntil = String(now - 1n); tree = render(); assert.equal(button(tree, 'Place bid').props.disabled, true); wire.validUntil = end;
  auction.winner = { bidder: buyer, amount: '100000000', premium: '12000000' };
  slots = []; tree = render(); await button(tree, 'Complete purchase').props.onClick(); tree = render();
  assert.equal(settled[1], 100000000n); assert.equal(settled[2], 12000000n);
  const completeHtml = renderToStaticMarkup(tree);
  assert.match(completeHtml, /Purchase complete/); assert.match(completeHtml, /Claims received/); assert.match(completeHtml, /position=1/);
  slots = ['', '', 'settle', false, { amount: 100000000n, premium: 10000000n }];
  sendState = { kind: 'sending', phase: 'confirming', hash: '0x01' }; step = 'approval';
  const progressHtml = renderToStaticMarkup(render());
  assert.doesNotMatch(progressHtml, /Purchase complete/); assert.match(progressHtml, /Waiting for payment approval/);
  sendState = { kind: 'error', message: 'Settlement reverted' }; step = 'purchase';
  assert.doesNotMatch(renderToStaticMarkup(render()), /Purchase complete/);
  auction.state = 'Filled'; auction.buyer = seller; auction.filledAmount = '100000000'; auction.winningPremium = '10000000';
  cursor = 0; const observer = renderToStaticMarkup(view.AuctionResult({ series, intent: wire, auctionId: '0x01' }));
  assert.match(observer, /Auction complete/); assert.doesNotMatch(observer, /Your claim|View position/);
  console.log('Auction checks passed: no buy-now path, reserve validation, full/partial bids, bid lifetime, winner settlement, approval failures, receipt and observer copy.');
  if (process.argv.includes('--screenshots')) {
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('http://localhost:3001/auctions', { waitUntil: 'networkidle' });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [name, html] of [['bid', initialHtml], ['approval', progressHtml], ['receipt', completeHtml]]) {
          await page.locator('main').evaluate((el, html) => { el.innerHTML = `<div class="mx-auto max-w-lg">${html}</div>`; }, html);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: `/tmp/erodoro-auction-${name}-${width}.png`, fullPage: true });
        }
      }
    } finally { await browser.close(); }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
