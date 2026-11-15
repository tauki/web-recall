// Visual QA for the production bundles with isolated IndexedDB and a test model.
// This never reads Chrome profiles, installed-extension data, or a live provider.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { providerFixture } from './provider-fixture.mjs';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const offline = process.argv.includes('--offline');
const empty = process.argv.includes('--empty');
const modelCachePreview = process.argv.includes('--model-cache');
const downloadPreview = process.argv.includes('--download-preview');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4180;
const cacheBundle = modelCachePreview ? (await build({ entryPoints: [path.join(root, 'src/offscreen/modelCache.ts')], bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].contents : null;
const backend = providerFixture('http://localhost:11434');
const { DEFAULT_SETTINGS } = await backend.load('src/shared/config/index.ts');
Object.assign(backend.stored.betaSettings, DEFAULT_SETTINGS, { paused: true, captureSetupComplete: true, queryRewrite: false, askRerank: false, enableTools: false, searchRerank: false, logLevel: 'debug' });
const database = await backend.load('src/shared/db/index.ts');
const library = empty ? [] : JSON.parse(await readFile(new URL('./fixtures/ui-library.json', import.meta.url), 'utf8'));
for (const [index, record] of library.entries()) await database.savePageRecord({ ...record, timestamp: Date.now() - Math.floor(index / 2) * 86400000, manual: index % 3 === 0, chunks: [{ text: record.text, embedding: [] }] });
await database.saveLog({ level: 'info', message: 'Isolated UI verification library loaded.', createdAt: Date.now(), data: { test: true, pages: library.length } });
await database.saveLog({ level: 'warn', message: 'Sample pages have no embeddings; text retrieval is available.', createdAt: Date.now() + 1, data: { test: true, missing: library.length } });
const orchestrator = await backend.load('src/background/orchestration/index.ts', {
  fetch: async (url, options = {}) => {
    if (offline) return Response.json({ error: 'No model available in this isolated preview' }, { status: 404 });
    const request = options.body ? JSON.parse(options.body) : {};
    const route = new URL(url).pathname;
    if (route.endsWith('/api/tags')) return Response.json({ models: [{ name: 'verification-model' }] });
    if (route.endsWith('/api/embed')) return Response.json({ embeddings: (request.input || ['']).map(() => [0.25, 0.75]) });
    if (route.endsWith('/api/chat')) {
      const content = 'Start with the saved page’s measurement guidance, then inspect the requests that delay useful content. [1]';
      return request.stream ? new Response(JSON.stringify({ message: { content } }) + '\n' + JSON.stringify({ done: true }) + '\n') : Response.json({ message: { content } });
    }
    return new Response('Ollama is running');
  }
});
orchestrator.orchestrateLifecycle();
const bridge = `
const cacheReady = ${modelCachePreview} ? (async () => {
  const marker = 'wr-model-cache-preview-seeded';
  if (sessionStorage.getItem(marker)) return;
  const cache = await caches.open('transformers-cache');
  for (const [model,revision,mb] of [
    ['onnx-community/embeddinggemma-300m-ONNX','75a84c732f1884df76bec365346230e32f582c82',1],
    ['onnx-community/embeddinggemma-2-ONNX','daa72c51243991dfcaf9f9137d2c573d8f7790c0',2]
  ]) {
    // Synthetic, non-runnable model files in this localhost origin only.
    for (const [file,body] of [['config.json',new TextEncoder().encode('{}')],['onnx/model.onnx',new Uint8Array(mb*1024*1024)]])
      await cache.put('https://huggingface.co/'+model+'/resolve/'+revision+'/'+file,new Response(body,{headers:{'Content-Length':String(body.byteLength)}}));
  }
  sessionStorage.setItem(marker,'yes');
})() : Promise.resolve();
// UI-only transfer fixture. Never requests or initializes real model weights.
let transfer=null, finishTransfer=null, transferTimer=null, transferAttempt=0;
function publishTransfer(update) {
  transfer={...transfer,...update};
  listeners.forEach(listener=>listener({type:'BROWSER_MODEL_DOWNLOAD_UPDATE',download:transfer}));
}
async function runtime(message) {
  if (${downloadPreview}) {
    if (message.type==='GET_BROWSER_MODEL_DOWNLOAD') return {download:transfer};
    if (message.type==='GET_BROWSER_EMBED_STATUS' && transfer?.state==='ready') return {status:{ready:true,state:'ready',runtimeAvailable:true,model:transfer.model,revision:transfer.revision}};
    if (message.type==='CANCEL_BROWSER_MODEL_DOWNLOAD' && transfer?.requestId===message.requestId) {
      clearInterval(transferTimer); publishTransfer({state:'cancelled'}); finishTransfer?.({error:'Download cancelled'}); return {cancelled:true};
    }
    if (message.type==='DOWNLOAD_BROWSER_EMBED') {
      if (transfer && ['downloading','preparing'].includes(transfer.state)) return {error:'Download already running'};
      transferAttempt++;
      transfer={requestId:message.requestId,model:message.model,revision:message.revision,startedAt:Date.now(),state:'downloading',file:'onnx/model_quantized.onnx',loadedBytes:0,totalBytes:192*1024*1024};
      publishTransfer({});
      return new Promise(resolve=>{
        finishTransfer=resolve;
        transferTimer=setInterval(()=>{
          publishTransfer({loadedBytes:Math.min(transfer.totalBytes,transfer.loadedBytes+16*1024*1024)});
          if (transferAttempt===2 && transfer.loadedBytes>=64*1024*1024) {
            clearInterval(transferTimer); publishTransfer({state:'error',error:'Connection interrupted'}); resolve({error:'Connection interrupted'});
          } else if (transfer.loadedBytes===transfer.totalBytes) {
            clearInterval(transferTimer); publishTransfer({state:'preparing'});
            transferTimer=setTimeout(()=>{publishTransfer({state:'ready'});resolve({ok:true});},5000);
          }
        },1500);
      });
    }
  }
  if (${modelCachePreview} && ['LIST_BROWSER_MODELS','DELETE_BROWSER_MODEL'].includes(message.type)) {
    await cacheReady;
    const api=await import('/model-cache.js');
    return message.type==='LIST_BROWSER_MODELS' ? {models:await api.listBrowserModelDownloads()} : {deletedFiles:await api.removeBrowserModelFiles(message.model,message.revision)};
  }
  return (await fetch('/runtime',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})).json();
}
const listeners=[];
window.chrome={runtime:{getURL:path=>'/'+path,onMessage:{addListener:listener=>listeners.push(listener)},sendMessage(message,callback){runtime(message).then(response=>{if(message.type==='SET_SETTINGS')listeners.forEach(listener=>listener({type:'BETA_SETTINGS_UPDATED',settings:response.settings}));callback(response);}).catch(error=>{window.chrome.runtime.lastError={message:error.message};try{callback();}finally{delete window.chrome.runtime.lastError;}});}},tabs:{create({url}){window.open(url,'_blank');}}};
`;
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:4180');
    if (url.pathname === '/runtime' && request.method === 'POST') {
      const parts = []; for await (const part of request) parts.push(part);
      const payload = await backend.send(JSON.parse(Buffer.concat(parts).toString()));
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(payload)); return;
    }
    if (url.pathname === '/bridge.js') { response.setHeader('Content-Type','text/javascript'); response.end(bridge); return; }
    if (url.pathname === '/model-cache.js' && cacheBundle) { response.setHeader('Content-Type','text/javascript'); response.end(cacheBundle); return; }
    if (url.pathname === '/') { response.writeHead(302, { Location: '/dist/beta/ui/sidepanel/index.html' }); response.end(); return; }
    const name = decodeURIComponent(url.pathname);
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(path.join(root,'dist/beta') + path.sep)) { response.writeHead(404); response.end(); return; }
    let body = await readFile(file);
    if (file.endsWith('.html')) body = Buffer.from(body.toString().replace('<script type="module"', '<script src="/bridge.js"></script><script type="module"'));
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); response.setHeader('Cache-Control','no-store'); response.end(body);
  } catch (error) { response.writeHead(500, {'Content-Type':'text/plain'}); response.end(error.message); }
});
server.listen(port, '127.0.0.1', () => console.log(`Production UI verification: http://127.0.0.1:${port}/ (isolated ${empty ? 'empty' : 'sample'} data; model ${offline ? 'unavailable' : 'fixture'})`));
