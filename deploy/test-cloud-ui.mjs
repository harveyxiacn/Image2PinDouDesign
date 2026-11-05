// Integration owner: real form clicks against compiled local assets or an explicitly supplied live URL.
// Creates only dedicated synthetic accounts; never prints passwords, cookies or recovery codes.
import { chromium } from '../pindou-hub/node_modules/playwright-core/index.mjs';
import { createCloudService } from '../pindou-hub/server/cloud/server.mjs';
import { createServer, request } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

let base=process.env.CLOUD_UI_BASE, local, service, dir, browser;
const report={target:base??'isolated local production build',checks:[],errors:[]};
const out=resolve('docs/samples',base?'cloud-ui-live':'cloud-ui-local');
const pass=name=>{report.checks.push(name);console.log(`PASS ${name}`);};
try {
  if(!base){
    const dist=resolve('pindou-hub/dist');
    assert.ok(existsSync(join(dist,'index.html')),'Build warehouse first');
    local=createServer((req,res)=>{
      if(req.url.startsWith('/cloud-api/')){
        const proxy=request({hostname:'127.0.0.1',port:service.server.address().port,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
        proxy.on('error',()=>res.writeHead(502).end());req.pipe(proxy);return;
      }
      const pathname=new URL(req.url,'http://localhost').pathname;
      let file=resolve(dist,'.'+pathname.replace(/^\/warehouse/,''));
      if(!file.startsWith(dist+sep)&&file!==dist){res.writeHead(403).end();return;}
      if(!existsSync(file)||!statSync(file).isFile())file=join(dist,'index.html');
      res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');
      res.end(readFileSync(file));
    });
    await new Promise(r=>local.listen(0,'127.0.0.1',r));
    const origin=`http://127.0.0.1:${local.address().port}`;
    base=origin+'/warehouse/';dir=mkdtempSync(join(tmpdir(),'pindou-ui-'));
    service=createCloudService({dir,origin,secure:false,minFreeBytes:0});
    await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  }
  assert.match(base,/^https?:\/\//);
  mkdirSync(out,{recursive:true});
  browser=await chromium.launch({executablePath:process.env.BROWSER_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const password=randomUUID()+randomUUID();
  const suffix=Date.now().toString(36);
  const users=[`qa_${suffix}_a`,`qa_${suffix}_b`];
  const contexts=await Promise.all(users.map(()=>browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'})));
  async function pageFor(context){const page=await context.newPage();page.on('dialog',d=>d.accept());page.on('pageerror',e=>report.errors.push(e.message));return page;}
  async function settings(page){await page.goto(base+'#/settings');await page.getByRole('heading',{name:'同步与设置',exact:true}).waitFor();}
  async function register(page,name){
    await settings(page);await page.getByRole('button',{name:'注册',exact:true}).click();
    await page.getByLabel(/^账户名/).fill(name);await page.getByLabel(/^密码（/).fill(password);
    await page.getByRole('button',{name:'注册并启用云同步',exact:true}).click();
    await page.getByRole('heading',{name:'保存你的恢复码'}).waitFor();
    await page.getByRole('button',{name:'已保存，进入私人豆仓'}).click();
    await page.getByRole('heading',{name:`私人豆仓 · ${name}`}).waitFor();
  }
  async function login(page,name){
    await settings(page);await page.getByLabel(/^账户名/).fill(name);await page.getByLabel(/^密码（/).fill(password);
    await page.getByRole('button',{name:'登录私人豆仓',exact:true}).click();
    await page.getByRole('heading',{name:`私人豆仓 · ${name}`}).waitFor();
  }
  const a=await pageFor(contexts[0]),b=await pageFor(contexts[1]);
  await settings(a);await a.getByText('现在是本地模式', {exact:false}).waitFor();pass('guest mode rendered');
  await register(a,users[0]);await register(b,users[1]);pass('two accounts registered through actual forms');
  const now=Date.now();
  const pattern={id:`qa_pattern_${suffix}`,name:'验收专用图纸',kind:'manual',method:'manual',counts:{A1:12},status:'planned',copies:1,tags:[],notes:'synthetic acceptance',createdAt:now,updatedAt:now};
  const fixture={app:'pindou-hub',records:[{collection:'patterns',id:pattern.id,data:pattern,updatedAt:now,deleted:false}]};
  await a.locator('input[type=file][accept="application/json,.json"]').setInputFiles({name:'acceptance.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await a.getByText('备份导入已完成（包含采购单）',{exact:true}).waitFor();
  await a.goto(base+'#/shopping');await a.getByLabel('采购单名称',{exact:true}).fill('验收专用采购单');
  await a.getByRole('button',{name:'保存当前采购单',exact:true}).click();
  await a.getByText('采购单快照已保存。',{exact:true}).waitFor();
  await a.locator('summary').filter({hasText:'验收专用采购单'}).click();
  await a.getByRole('button',{name:'整单收货入库',exact:true}).click();
  await a.getByRole('button',{name:'已收货，不会重复入库'}).waitFor();pass('import, purchase snapshot and receipt through UI');
  const headers={'x-pindou-client':'web'};
  const meA=await (await contexts[0].request.get(new URL('/cloud-api/me',base).href,{headers})).json();
  const meB=await (await contexts[1].request.get(new URL('/cloud-api/me',base).href,{headers})).json();
  const api=async(context,path,id)=>context.request.get(new URL('/cloud-api/'+path,base).href,{headers:{...headers,'x-pindou-account':id}});
  const stateA=await (await api(contexts[0],'state',meA.user.id)).json();
  assert.equal(stateA.records.filter(r=>r.collection==='orders').length,1);
  for(const path of ['state','export','changes?since=0']){
    assert.equal((await api(contexts[1],path,meA.user.id)).status(),403);
    const own=await(await api(contexts[1],path,meB.user.id)).json();assert.equal(own.records.length,0);
  }
  pass('two-account state, export and incremental isolation');
  await b.goto(base+'#/shopping');await b.getByText('还没有保存的采购单。',{exact:false}).waitFor();
  const secondDevice=await browser.newContext();const a2=await pageFor(secondDevice);await login(a2,users[0]);
  await a2.goto(base+'#/shopping');await a2.locator('summary').filter({hasText:'验收专用采购单'}).waitFor();pass('second-device login restores saved purchase order');
  await settings(a2);const downloadPromise=a2.waitForEvent('download');await a2.getByRole('button',{name:'导出备份 JSON',exact:true}).click();
  const download=await downloadPromise;const stream=await download.createReadStream();let text='';for await(const chunk of stream)text+=chunk;
  assert.ok(JSON.parse(text).records.some(r=>r.collection==='orders'));pass('UI backup contains orders');
  await a2.getByRole('button',{name:'退出登录，返回本地模式'}).click();await a2.getByText('现在是本地模式',{exact:false}).waitFor();pass('logout returns to guest');
  await contexts[0].clearCookies();await settings(a).catch(()=>{});await a.getByRole('heading',{name:'验证私人豆仓'}).waitFor();
  await a.getByRole('button',{name:'返回本地模式',exact:true}).click();await a.getByText('现在是本地模式',{exact:false}).waitFor();pass('expired session hides cache and offers guest mode');
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await a.screenshot({path:join(out,'guest-mobile.png'),fullPage:true});
  assert.deepEqual(report.errors,[]);pass('mobile viewport and no page errors');
}catch(error){report.failure=error.message;throw error;}
finally{
  mkdirSync(out,{recursive:true});writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();await service?.close();if(local)await new Promise(r=>local.close(r));
  if(dir&&resolve(dir).startsWith(resolve(tmpdir())+sep)&&join(tmpdir(),dir.split(sep).at(-1))===dir)rmSync(dir,{recursive:true,force:true});
}
