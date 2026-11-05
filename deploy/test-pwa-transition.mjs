// Real Chrome check: old catch-all navigation worker -> prompted update -> separate warehouse.
import { chromium } from '../pindou-hub/node_modules/playwright-core/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const dist=resolve('dist'), out=resolve('docs/samples/pwa-transition');
mkdirSync(out,{recursive:true});
const currentSw=readFileSync(resolve(dist,'sw.js'),'utf8');
const legacySw=currentSw.replace(/,\{denylist:\[[\s\S]*?\]\}/,'');
assert.notEqual(legacySw,currentSw,'Build must include navigation denylist');
let upgraded=false;
const mime={'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json','.wasm':'application/wasm'};
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cache-Control','no-store');
  if(path==='/sw.js'){res.setHeader('Content-Type','application/javascript');res.end(upgraded?currentSw:legacySw);return;}
  if(path==='/warehouse/'){res.setHeader('Content-Type','text/html');res.end('<h1>Warehouse route reached server</h1>');return;}
  if(path==='/cloud-api/me'){res.setHeader('Content-Type','application/json');res.end('{"user":null}');return;}
  const file=resolve(dist,'.'+(path==='/'?'/index.html':path));
  if(!file.startsWith(dist+sep)||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.end(readFileSync(file));
});
let browser;
const report={checks:[],errors:[]};
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.BROWSER_PATH??'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  const page=await browser.newPage({reducedMotion:'reduce'});page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base+'/');
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.goto(base+'/warehouse/');
  await page.getByRole('heading',{name:'拼豆图纸工坊',exact:true}).waitFor();
  report.checks.push('Legacy catch-all worker reproduces warehouse navigation interception');
  upgraded=true;
  await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration('/');await r.update();});
  await page.getByRole('button',{name:'刷新到新版本',exact:true}).click({timeout:20000});
  await page.getByRole('heading',{name:'Warehouse route reached server'}).waitFor({timeout:20000});
  report.checks.push('Existing prompt updates worker; warehouse navigation reaches separate app');
  await page.goto(base+'/cloud-api/me');
  assert.match(await page.locator('body').innerText(),/"user":null/);
  report.checks.push('Cloud API navigation is not replaced by workshop shell');
  await page.goto(base+'/');await page.setViewportSize({width:390,height:844});
  await page.getByRole('link',{name:'私人豆仓',exact:true}).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:resolve(out,'workshop-mobile.png'),fullPage:true});
  report.checks.push('390px workshop entrance visible without horizontal overflow');
  assert.deepEqual(report.errors,[]);
} finally {
  if(browser)await browser.close();
  await new Promise(r=>server.close(r));
  writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
