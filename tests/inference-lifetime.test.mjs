import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, tick, plain, waitFor, scanFixturePages } from './helpers.mjs';

function lifetimeContext() {
  const timers = new Map(); let ticks = 0, serial = 0;
  return {
    timers, ticks: () => ticks,
    context: {
      chrome: { ...chromeFixture, runtime: { ...chromeFixture.runtime, getPlatformInfo: async () => {ticks++;} } },
      setInterval(callback, ms) {const id=++serial; timers.set(id,{callback,ms}); return id;},
      clearInterval(id) {assert.equal(timers.delete(id),true);}
    }
  };
}

test('inference keeps the worker alive only while pending, including concurrent work', async () => {
  const f=lifetimeContext();
  const mod=await loadSource('src/background/providers/inference.ts','',{},f.context);
  let finish, fail;
  const success=mod.runInference(() => new Promise(resolve => {finish=resolve;}));
  const failure=mod.runInference(() => new Promise((_resolve,reject) => {fail=reject;}));
  const rejection=assert.rejects(failure,/cancelled/);
  assert.equal(f.timers.size,2);
  for (const timer of f.timers.values()) {assert.ok(timer.ms < 30000); timer.callback();}
  assert.equal(f.ticks(),2);
  finish('done'); assert.equal(await success,'done'); assert.equal(f.timers.size,1);
  fail(Error('cancelled')); await rejection; assert.equal(f.timers.size,0);
});

test('Ollama embeddings have no automatic deadline and cancellation releases keepalive', async () => {
  const f=lifetimeContext(); let requestSignal, started;
  const ready=new Promise(resolve => {started=resolve;});
  const mod=await loadSource('src/background/embeddings/index.ts','',{
    '../offscreen/index':{ensureOffscreenDocument:async()=>{},sendOffscreenMessage:async()=>({})}
  }, {...f.context, AbortSignal:{timeout(){throw Error('Automatic deadline is forbidden');}},
    fetch:async (_url,{signal}) => {requestSignal=signal; started(); return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
  });
  const controller=new AbortController();
  const pending=mod.computeEmbeddingsForChunks(['passage'],controller.signal);
  await ready;
  assert.equal(requestSignal,controller.signal); assert.equal(f.timers.size,1);
  controller.abort(Error('User stopped'));
  await assert.rejects(pending,/User stopped/); assert.equal(f.timers.size,0);
});

test('chat, JSON reranking and inference probes use caller cancellation without deadlines', async () => {
  const signals=[];
  const mod=await loadSource('src/background/providers/chat.ts','',{'../settings/index':{getSettings:async()=>({}),acknowledgeRemoteProviderOrigin:async()=>assert.fail('Local inference must not request remote acknowledgement')},'./config':{getProviderBaseUrl:async()=>''}}, {
    chrome:chromeFixture, AbortSignal:{timeout(){throw Error('Automatic deadline is forbidden');}},
    fetch:async (_url,{signal}) => {signals.push(signal); return Response.json({message:{content:'{"ok":true}'}});}
  });
  const signal=new AbortController().signal;
  const config={baseUrl:'http://localhost:11434',model:'test',providerId:'ollama',signal};
  assert.ok((await mod.probeChat(config)).ok);
  await mod.callChat(config,{});
  assert.deepEqual(plain(await mod.callChatJson(config,{})),{ok:true});
  assert.deepEqual(signals,[signal,signal,signal]);
});

test('streaming keeps the worker alive through the response body and cleans up on Stop', async () => {
  const f=lifetimeContext(); let requestSignal, body;
  const mod=await loadSource('src/background/providers/chat.ts','',{'../settings/index':{getSettings:async()=>({}),acknowledgeRemoteProviderOrigin:async()=>assert.fail('Local inference must not request remote acknowledgement')},'./config':{getProviderBaseUrl:async()=>''}}, {
    ...f.context, AbortSignal:{timeout(){throw Error('Automatic deadline is forbidden');}},
    fetch:async (_url,{signal}) => {
      requestSignal=signal;
      return {ok:true,body:new ReadableStream({start(controller){body=controller; signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});}})};
    }
  });
  const controller=new AbortController(); const updates=[];
  const pending=mod.streamChat({baseUrl:'http://localhost',signal:controller.signal},{},chunk=>updates.push(chunk));
  await tick();
  body.enqueue(new TextEncoder().encode('{"message":{"content":"Hello"}}\n'));
  await tick(); assert.deepEqual(updates,['Hello']); assert.equal(f.timers.size,1);
  assert.equal(requestSignal,controller.signal);
  controller.abort(Error('User stopped'));
  await assert.rejects(pending,/User stopped/); assert.equal(f.timers.size,0);
});

test('memory search tool waits for local inference and ignores obsolete timeout settings', async () => {
  let finish; const pending=new Promise(resolve=>{finish=resolve;});
  const {ToolsRuntime}=await loadSource('src/shared/tools/runtime.ts','',{}, {setTimeout(){throw Error('No tool deadline');}});
  const runtime=new ToolsRuntime({allowedUrls:new Set(),pageText:new Map(),pages:[],toolTimeoutMs:8000,allowSearchDiscovery:true,
    searchMemory:()=>pending});
  const result=runtime.runToolCall('search_memory',{query:'slow inference'});
  await tick();
  finish([{url:'https://example.test',title:'Relevant page',snippet:'Evidence'}]);
  const payload=JSON.parse((await result).content);
  assert.equal(payload.data[0].title,'Relevant page');
});

test('explicit cancellation targets only its operation and prevents duplicate request IDs', async () => {
  const mod=await loadSource('src/background/orchestration/operations.ts');
  let searchSignal, backfillSignal;
  const search=mod.runOperation('search','id',signal=>{searchSignal=signal; return new Promise(()=>{});});
  const backfill=mod.runOperation('backfill','id',signal=>{backfillSignal=signal; return new Promise(()=>{});});
  const searchStopped=assert.rejects(search,/Stopped by user/);
  const backfillStopped=assert.rejects(backfill,/Stopped by user/);
  await assert.rejects(mod.runOperation('search','id',async()=>{}),/already running/);
  assert.equal(mod.cancelOperation('search','unknown'),false);
  assert.equal(mod.cancelOperation('search','id'),true);
  await searchStopped;
  assert.equal(searchSignal.aborted,true); assert.equal(backfillSignal.aborted,false);
  assert.equal(mod.cancelOperation('search','id'),false);
  mod.cancelOperation('backfill','id'); await backfillStopped;
  assert.equal(await mod.runOperation('search','id',async()=>'new request'),'new request');
});

test('stopping backfill aborts inference, preserves existing vectors and skips later pages', async () => {
  const controller=new AbortController(); let requests=0, writes=0, signal;
  const page={url:'https://a.test',title:'Saved page',versionId:'saved-a',timestamp:1,text:'saved\n\nmissing',manual:true,chunks:[{text:'saved',embedding:[9,9]},{text:'missing',embedding:[]}],createdAt:1,updatedAt:1};
  const pages=[page,{...page,url:'https://b.test'}];
  const mod=await loadSource('src/background/embeddings/backfill.ts','',{
    '../summaries/index': { queuePageSummary: async () => false },
    './index':{getEmbeddingConfig:()=>({provider:'ollama',model:'test',baseUrl:'http://localhost'}),computeEmbeddingsForChunks:async(_text,s)=>{requests++;signal=s;return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));}},
    '../storage/manager':{storageManager:{listAllPages:async()=>pages,getPageRecord:async url=>pages.find(page=>page.url===url),getProcessingEntry:async()=>undefined,savePageRecord:async()=>{writes++;}}},
    '../offscreen/index':{invalidateOffscreenIndex:async()=>{}},'../../shared/logger/index':{log:async()=>{}}
  });
  const pending=mod.backfillMissingEmbeddings(2,false,undefined,undefined,controller.signal);
  await tick(); controller.abort(Error('Stopped by user'));
  await assert.rejects(pending,/Stopped by user/);
  assert.equal(signal.aborted,true); assert.equal(requests,1); assert.equal(writes,0);
  assert.deepEqual(page.chunks[0].embedding,[9,9]);
});

test('Search passes cancellation to query rewriting and reranking without starting more inference', async () => {
  for (const stage of ['rewrite','rerank']) {
    let requestSignal, calls=0, embeddings=0;
    const page={url:'https://example.test',title:'Saved report',text:'Coastal observations.',timestamp:1,versionId:'saved-version',chunks:[{text:'Coastal observations.',embedding:[1,0]}]};
    const chat=async(config)=>{requestSignal=config.signal;calls++;return new Promise((_resolve,reject)=>config.signal.addEventListener('abort',()=>reject(config.signal.reason),{once:true}));};
    const mod=await loadSource('src/background/search/index.ts','',{
      '../providers/chat':{getChatConfig:async signal=>({model:'test',signal}),callChat:chat,callChatJson:chat},
      '../settings/index':{getSettings:async()=>({queryRewrite:stage==='rewrite',searchRerank:stage==='rerank'})},
      '../storage/manager':{storageManager:{scanSearchPages:scanFixturePages([page]),getPageRecord:async()=>page}},
      '../embeddings/index':{computeEmbeddingsForQueries:async()=>{embeddings++;return [[1,0]];},getEmbeddingConfig:()=>({})},
      '../offscreen/index':{ensureOffscreenDocument:async()=>{},sendOffscreenMessage:async message=>message.type==='OFFSCREEN_TOP_PAGES'?{pages:[{url:page.url}]}:{candidates:[{...page,snippet:page.text,score:1,chunkIndex:0}]}}
    });
    const controller=new AbortController();
    const pending=mod.searchStoredPages('ocean flight',10,{signal:controller.signal});
    try {
      await waitFor(()=>requestSignal,`${stage} inference to start`);
      assert.equal(requestSignal.aborted,false);
    } finally { controller.abort(Error('Stopped by user')); await pending.catch(()=>{}); }
    await assert.rejects(pending,/Stopped by user/);
    assert.equal(requestSignal.aborted,true);
    assert.match(requestSignal.reason.message,/Stopped by user/);
    assert.equal(calls,1);
    assert.equal(embeddings,stage==='rewrite'?0:1);
  }
});
