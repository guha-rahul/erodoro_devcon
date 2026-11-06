import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as viem from 'viem';
function load(file, imports={}, globals={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{if(!(name in imports))throw new Error(name);return imports[name];},Date,Map,Set,URLSearchParams,...globals});
  return exports;
}
const model=load('../lib/rips/model.ts');
const share=load('../lib/rips/share.ts');
const abi=load('../lib/abis/MarketRipPool.ts');
const b20=load('../lib/b20-errors.ts',{viem});
const purchase=load('../lib/rips/purchase.ts',{viem,'../abis/MarketRipPool':abi,'../b20-errors':b20});
const pool='0x1111111111111111111111111111111111111111', buyer='0x2222222222222222222222222222222222222222', other='0x3333333333333333333333333333333333333333', ref=`0x${'ab'.repeat(32)}`;
const lot={id:'fixture',source:'demo',symbol:'ETH',name:'Ethereum',strike:100,spot:95,expiryTs:1800000000,askPrice:0.5,availableUsd:25};
test('demo fills merge actual simulated spend and stay separate from wallet claims',()=>{
 const first=model.addFill([],lot,{kind:'rip',qty:2,paid:1,at:1700000000000});
 const next=model.addFill(first.positions,lot,{kind:'buy',qty:10,paid:5,at:1700000001000});
 assert.equal(next.positions.length,1);assert.equal(model.totalPaid(next.position),6);assert.equal(model.totalQty(next.position),12);assert.equal(next.position.live,undefined);
});
test('demo selection excludes unavailable inventory',()=>{
 assert.equal(model.pickLot([{...lot,availableUsd:0}],0.5),null);
 assert.equal(model.pickLot([{...lot,availableUsd:0.5},lot],0).id,lot.id);
});
test('only the successful pool receipt for this buyer and exact payment is a purchase',()=>{
 const topics=viem.encodeEventTopics({abi:abi.MarketRipPoolAbi,eventName:'RipPurchased',args:{buyer,batchId:1n,positionId:2n}});
 const data=viem.encodeAbiParameters([{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'bytes32'}],[other,3n,100000000n,1000000n,ref]);
 const receipt={status:'success',logs:[{address:pool,topics,data}]};
 assert.equal(purchase.decodePurchase(receipt,pool,buyer,1000000n).units,100000000n);
 assert.throws(()=>purchase.decodePurchase({...receipt,status:'reverted'},pool,buyer,1000000n),/reverted/);
 for(const args of [[other,buyer,1000000n],[pool,other,1000000n],[pool,buyer,5000000n]])assert.throws(()=>purchase.decodePurchase(receipt,...args),/could not be verified/);
});
test('inventory commitments exclude downside, stale quotes and dust and bind repricing',()=>{
 const row={batchId:1n,direction:0,remainingUnits:500n,unitsPerRip:100n,quoteRef:ref,quoteValidUntil:1000n,expiry:2000n};
 const rows=[{id:1n,row}], original=purchase.inventoryCommitment(1n,rows,900n), empty=purchase.inventoryCommitment(1n,[],900n);
 assert.equal(purchase.inventoryCommitment(1n,[...rows,{id:2n,row:{...row,direction:1}}],900n),original);
 assert.equal(purchase.inventoryCommitment(1n,[{id:1n,row:{...row,remainingUnits:99n}}],900n),empty);
 assert.equal(purchase.inventoryCommitment(1n,rows,1001n),empty);
 assert.notEqual(purchase.inventoryCommitment(1n,[{id:1n,row:{...row,unitsPerRip:101n}}],900n),original);
});
test('share data rejects tampering and labels demo and testnet purchases',()=>{
 assert.equal(share.readShared('?r=<script>&d=30'),null);assert.equal(share.readShared('?r=ETH&d=9999'),null);
 const s={symbol:'ETH',move:'+5%',termDays:30,demo:true,paid:6};
 assert.equal(share.readShared(new URL(share.shareLink(s,'https://example.test')).search).demo,true);
 assert.match(share.shareText(s),/demo, no funds moved/);assert.match(share.shareText({...s,demo:false,testnet:true}),/Base Sepolia test assets/);
});
test('signing rejection, quote races, empty liquidity and uncertainty have recoverable errors',()=>{
 assert.match(purchase.purchaseError(new Error('User rejected signing 4001')),/cancelled/);
 assert.match(purchase.purchaseError(new Error('QuoteChanged')),/review the new price/);
 assert.match(purchase.purchaseError(new Error('NoInventory')),/liquidity/);
 assert.match(purchase.purchaseError(new Error('OwnListing()')),/your own listing/);
 assert.match(purchase.purchaseError(new Error('MetaMask - RPC Error: Transaction relay error - FAILED_WOULD_REVERT')),/Nothing was charged/);
 assert.match(purchase.purchaseError(new Error('Purchase confirmed on chain, but loading it failed. Use the receipt link below; reload My Rips to show it.')),/confirmed on chain/);
 assert.match(purchase.purchaseError(new Error('HTTP timeout')),/before retrying/);
});

test('live totals use on-chain lifetime cost and current holdings after transfers',()=>{
 const p={fills:[{qty:100,paid:999}],live:{heldRaw:'200000000',unitDecimals:8,purchasedCostRaw:'7000000'}};
 assert.equal(model.totalQty(p),2);assert.equal(model.totalPaid(p),7);
});

test('concurrent history refreshes scan once and recover actual receipt cost and mode',async()=>{
 let scans=0;
 const hash=`0x${'12'.repeat(32)}`;
 const client={
  getBlockNumber:async()=>100n,
  getLogs:async({args,fromBlock,toBlock})=>{scans++;assert.equal(args.buyer,buyer);assert.equal(fromBlock,100n);assert.equal(toBlock,100n);return [{transactionHash:hash,blockNumber:100n,args:{positionId:2n,units:200000000n,usdcPaid:1000000n}}];},
  getBlock:async()=>({timestamp:1700000000n}),
  getTransaction:async()=>({input:viem.encodeFunctionData({abi:abi.MarketRipPoolAbi,functionName:'buyPosition',args:[2n,1n,200000000n,ref]})}),
 };
 const history=load('../lib/rips/history.ts',{viem,'../chain':{publicClient:client},'../deployment':{DEPLOYMENT:{chainId:84532},BUILD_CHAIN_ID:84532},'../abis':abi},{process:{env:{NEXT_PUBLIC_RIP_DEPLOY_BLOCK:'100'}}});
 const [a,b]=await Promise.all([history.loadHistory(pool,buyer),history.loadHistory(pool,buyer)]);
 assert.equal(scans,1);assert.equal(a.length,1);assert.equal(b.length,1);
 const fill=history.fillsFor(a,2n,8)[0];assert.equal(fill.qty,2);assert.equal(fill.paid,1);assert.equal(fill.kind,'buy');assert.equal(fill.signature,hash);
 await history.loadHistory(pool,buyer);assert.equal(scans,1);
});

test('a pool read on another chain fails before token approval or liquidity reads',async()=>{
 let reads=0;
 const live=load('../lib/rips/live.ts',{viem,'../abis':{},'../chain':{publicClient:{getChainId:async()=>8453,readContract:async()=>{reads++;}}},'../deployment':{DEPLOYMENT:{chainId:84532,contracts:{ripPool:pool}}},'../issuers':{},'./history':{} });
 await assert.rejects(live.validatePool(),/another chain/);assert.equal(reads,0);
});


test('quote expiry removes buying availability while preserving readable position metadata',()=>{
 const live=load('../lib/rips/live.ts',{viem,'../abis':{},'../chain':{},'../deployment':{},'../issuers':{},'./history':{}});
 const catalog=[{...lot,id:'1',source:'live'}];
 const row={direction:0,unitsPerRip:100n,remainingUnits:500n,quoteValidUntil:1000n,expiry:2000n};
 const atDeadline=live.selectLiveLots(catalog,[{id:1n,row}],1000n);
 assert.equal(atDeadline.executable.length,1);
 const expired=live.selectLiveLots(catalog,[{id:1n,row}],1001n);
 assert.equal(expired.executable.length,0);assert.equal(expired.catalog[0].id,'1');assert.equal(expired.catalog[0].strike,100);
 assert.equal(live.selectLiveLots(catalog,[{id:1n,row:{...row,unitsPerRip:0n}}],900n).executable.length,0);
 assert.equal(live.selectLiveLots(catalog,[{id:1n,row:{...row,remainingUnits:99n}}],900n).executable.length,0);
 assert.equal(live.selectLiveLots(catalog,[{id:1n,row}],2000n).executable.length,0);
});


test('purchase history stays within the public RPC 200-block log limit and resumes without rescanning',async()=>{
 const ranges=[];
 const client={getBlockNumber:async()=>500n,getLogs:async({fromBlock,toBlock})=>{assert.ok(toBlock-fromBlock<200n);ranges.push([String(fromBlock),String(toBlock)]);return [];}};
 const history=load('../lib/rips/history.ts',{viem,'../chain':{publicClient:client},'../deployment':{DEPLOYMENT:{chainId:84532},BUILD_CHAIN_ID:84532},'../abis':abi},{process:{env:{NEXT_PUBLIC_RIP_DEPLOY_BLOCK:'100'}}});
 await history.loadHistory(pool,buyer);
 assert.deepEqual(ranges,[['100','299'],['300','499'],['500','500']]);
 await history.loadHistory(pool,buyer);assert.equal(ranges.length,3);
});

test('a transient RPC failure retains verified holdings and disables stale purchase quotes',async()=>{
 const cells=[];let cursor=0,fail=false;
 const react={
  useState:initial=>{const i=cursor++;if(!(i in cells))cells[i]=initial;return [cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value;}];},
  useRef:value=>{const i=cursor++;if(!(i in cells))cells[i]={current:value};return cells[i];},
  useCallback:fn=>fn,useMemo:fn=>fn(),useEffect:()=>{},
 };
 const row={direction:0,claims:pool,claimId:3n,unitsPerRip:100n,remainingUnits:500n,quoteValidUntil:2000n,expiry:3000n};
 const holding={positionId:1n,position:row,settled:false};
 const position={id:'live:1',lotId:'1',source:'live',fills:[],live:{heldRaw:'100',unitDecimals:8,purchasedCostRaw:'1000000'}};
 const snapshot={batchId:1n,positions:[{id:1n,row}],holdings:[holding]};
 const live=load('../lib/rips/live.ts',{viem,'../abis':{},'../chain':{},'../deployment':{},'../issuers':{},'./history':{}});
 const state=load('../lib/rips/use-rips.ts',{
  react,wagmi:{useAccount:()=>({address:buyer,chainId:84532}),useConfig:()=>({}),useWriteContract:()=>({})},'wagmi/actions':{},viem,
  '../chain':{},'../deployment':{DEPLOYMENT:{chainId:84532,contracts:{ripPool:pool}},IS_TESTNET:true},'../abis':{},'../use-now':{useNow:()=>1000},
  './model':model,'./ui':{RIPS_SHOW_DEMO:false},'./prices':{stockPrice:async()=>null,prefetchStockPrices:()=>{}},'./demo':{demoLots:()=>[]},'./store':{useDemoConsumed:()=>({consumed:[],consume:()=>{}}),useStoredPositions:()=>({positions:[],save:()=>{}}),positionsKey:()=> 'test'},
  './live':{...live,validatePool:async()=>{if(fail)throw Error('HTTP timeout');return true;},loadSnapshot:async()=>snapshot,lotFor:async()=>({...lot,id:'1',source:'live'}),heldPosition:()=>position},'./purchase':purchase,
 });
 const render=()=>{cursor=0;return state.useRipsState();};
 let current=render();await current.refresh();current=render();
 assert.equal(current.positions[0].id,'live:1');assert.equal(current.lots.length,1);
 fail=true;await current.refresh();current=render();
 assert.equal(current.snapshot,snapshot);assert.equal(current.positions[0].id,'live:1');
 assert.equal(model.totalPaid(current.positions[0]),1);assert.equal(current.lots.length,0);
 assert.equal(current.supported,false);assert.equal(current.liveState,'error');assert.match(current.error,/last successful read/);
 fail=false;await current.refresh();current=render();assert.equal(current.liveState,'ready');assert.equal(current.lots.length,1);assert.equal(current.error,null);
});

test('a stock token refusing the transfer is explained, wherever its revert data sits',()=>{
 const errs=viem.parseAbi(['error PolicyForbids(bytes32 policyScope, uint64 policyId)','error ContractPaused(uint8 feature)','error EnforcedPause()']);
 const raw=(errorName,args)=>new viem.RawContractError({data:viem.encodeErrorResult({abi:errs,errorName,args})});
 assert.match(b20.b20RevertMessage(raw('PolicyForbids',[`0x${'11'.repeat(32)}`,7n])),/eligibility policy/);
 assert.match(b20.b20RevertMessage(raw('ContractPaused',[0])),/paused transfers/);
 assert.match(b20.b20RevertMessage(raw('EnforcedPause',[])),/paused transfers/);
 assert.match(b20.b20RevertMessage(new Error('execution reverted: PolicyForbids')),/eligibility policy/);
 assert.equal(b20.b20RevertMessage(new viem.RawContractError({data:'0x08c379a0'})),null);
 assert.equal(b20.b20RevertMessage(new Error('QuoteChanged')),null);
 assert.match(purchase.purchaseError(raw('ContractPaused',[0])),/paused transfers/);
});
test('packs available is what the tenth-deepest stock can supply, mirroring the pool',()=>{
 const house='0x00000000000000000000000000000000000000aa', seller='0x00000000000000000000000000000000000000bb', me='0x00000000000000000000000000000000000000cc';
 const stock=i=>`0x${(i+1).toString(16).padStart(40,'0')}`;
 const row=(i,o={})=>({row:{stock:stock(i),seller:house,direction:0,batchId:1n,remainingUnits:5n*100n,unitsPerRip:100n,quoteValidUntil:2000n,expiry:3000n,...o}});
 const ten=Array.from({length:10},(_,i)=>row(i));
 // $5 each: slices while a full $1 remains = (500-100)/10 + 1 = 41.
 assert.equal(purchase.packsAvailable(ten,1000n,me,house),41);
 assert.equal(purchase.packsAvailable(ten.slice(0,9),1000n,me,house),0,'fewer than ten stocks');
 const thin=[...ten.slice(0,9),row(9,{remainingUnits:150n})];
 assert.equal(purchase.packsAvailable(thin,1000n,me,house),6,'the shallowest of ten sets the limit');
 assert.equal(purchase.packsAvailable([...thin,row(10)],1000n,me,house),41,'an eleventh stock covers the thin one');
 assert.equal(purchase.packsAvailable(ten,2500n,me,house),0,'quotes lapsed');
 const listing=row(9,{seller,remainingUnits:1000n,unitsPerRip:100n});
 assert.equal(purchase.packsAvailable([...thin,listing],1000n,me,house),41,'a seller listing at the house price deepens the thin stock (6 + 91 slices)');
 assert.equal(purchase.packsAvailable([...thin,listing],1000n,seller,house),6,'never the buyer\'s own listing');
 assert.equal(purchase.packsAvailable([...thin,{row:{...listing.row,unitsPerRip:90n}}],1000n,me,house),6,'a listing dearer than the house is not blind-eligible');
});

test('house and seller listings of one stock are one holding: balance once, spend summed',()=>{
 const live=load('../lib/rips/live.ts',{viem,'../abis':abi,'../chain':{publicClient:{}},'../deployment':{DEPLOYMENT:{chainId:84532,contracts:{}}},'../issuers':{assetFor:()=>null},'./history':{loadHistory:async()=>[],fillsFor:()=>[]}});
 const claims='0x4444444444444444444444444444444444444444';
 const row=(claimId)=>({claims,claimId,stock:other,strike:36205000000n,priceDecimals:8,spotAtCreation:34481000000n,expiry:1794333600n,direction:0,quoteValidUntil:0n});
 const holding=(positionId,claimId,bought,at)=>({positionId,bought,purchased:bought*25000n,units:7500000n,unitDecimals:8,settlementModel:1,position:row(claimId),settled:false,settlementValue:null,fills:[{kind:'rip',qty:0.01,paid:Number(bought)/1e6,at}],asset:{symbol:'tAAPL',name:'Test Apple'}});
 const merged=live.byClaim([holding(12n,7n,100000n,2),holding(21n,7n,200000n,1),holding(13n,9n,300000n,3)]);
 assert.equal(merged.length,2);
 assert.equal(merged[0].positionId,12n);assert.equal(merged[0].units,7500000n);assert.equal(merged[0].bought,300000n);
 assert.deepEqual(Array.from(merged[0].fills,f=>f.at),[1,2]);
 assert.equal(model.totalPaid(live.heldPosition(merged[0])),0.3);
});
