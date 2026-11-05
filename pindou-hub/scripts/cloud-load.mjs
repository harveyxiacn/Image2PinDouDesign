// Isolated synthetic load; never point this at production or an existing data directory.
import { createCloudService } from '../server/cloud/server.mjs';
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const results = [];
for (const concurrency of [5, 10, 20]) {
  const dir = mkdtempSync(join(tmpdir(), 'pindou-load-'));
  const origin = 'http://localhost:5174';
  const service = createCloudService({dir, origin, secure:false, minFreeBytes:0});
  const samples = []; let failures = 0; let peakRss = process.memoryUsage().rss;
  const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
  try {
    await new Promise(r => service.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${service.server.address().port}/cloud-api/`;
    async function api(path, user, body) {
      const start = performance.now();
      const response = await fetch(base + path, {
        method:body === undefined ? 'GET':'POST',
        headers:{'x-pindou-client':'web',origin,...(user?{cookie:user.cookie,'x-pindou-account':user.id}:{}),...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})
      });
      const data = await response.json();
      samples.push({path, ms:performance.now()-start, status:response.status});
      if (!response.ok) { failures++; throw new Error(`${path}: ${response.status} ${data.error}`); }
      return {data, cookie:response.headers.get('set-cookie')?.split(';')[0]};
    }
    const users = [];
    for(let i=0;i<concurrency;i++) {
      const username=`load_${i}`, password=randomUUID();
      const r=await api('register', null, {username,password});
      users.push({id:r.data.user.id,cookie:r.cookie,username,password,revision:0});
    }
    const start = performance.now();
    const sampleStart = samples.length;
    await Promise.all(users.map(async (u, index) => {
      for(let round=0;round<10;round++) {
        await api('me',u);
        const state=(await api(`changes?since=${u.revision}&limit=200`,u)).data;
        if(state.more) throw new Error('Unexpected incomplete synthetic pull');
        u.revision=state.revision;
        const id=`order_${index}_${round}`, now=Date.now();
        const record={collection:'orders',id,updatedAt:now,deleted:false,data:{id,name:'Synthetic load order',items:[{code:'A1',qty:10}],status:'saved',createdAt:now,updatedAt:now}};
        let response=await api('mutate',u,{mutationId:randomUUID(),baseRevision:u.revision,operation:{type:'records',records:[record]}});
        u.revision=response.data.revision;
        response=await api('mutate',u,{mutationId:randomUUID(),baseRevision:u.revision,operation:{type:'receiveOrder',orderId:id}});
        u.revision=response.data.revision;
      }
    }));
    const seconds=(performance.now()-start)/1000;
    // Reauthentication is sequential to exercise hashing within the bounded admission queue.
    for(const u of users.slice(0,Math.min(10,concurrency))) await api('login',null,{username:u.username,password:u.password});
    for(const u of users) {
      const records=(await api('state',u)).data.records;
      const balance=records.filter(r=>r.collection==='txns'&&!r.deleted).reduce((n,r)=>n+r.data.delta,0);
      if(balance!==100) throw new Error(`Inventory mismatch: ${balance}`);
    }
    const workload=samples.slice(sampleStart).filter(s=>s.path!=='login');
    const sorted=workload.map(s=>s.ms).sort((a,b)=>a-b);
    const auth=samples.filter(s=>s.path==='login'||s.path==='register').map(s=>s.ms).sort((a,b)=>a-b);
    results.push({concurrency,roundsPerSession:10,operations:'me + incremental pull + save order + receive order; sequential registration/login; final inventory check',requests:workload.length,workloadSeconds:seconds,requestsPerSecond:concurrency*40/seconds,p95Ms:sorted[Math.ceil(sorted.length*.95)-1],authP95Ms:auth[Math.ceil(auth.length*.95)-1],failures,peakRssMiB:peakRss/1048576,steadyRssMiB:process.memoryUsage().rss/1048576});
  } finally {
    clearInterval(monitor);
    await service.close();
    const target=realpathSync(dir), parent=realpathSync(tmpdir());
    if(resolve(dirname(target))!==resolve(parent)||!target.includes('pindou-load-')) throw new Error('Unsafe temporary cleanup target');
    rmSync(target,{recursive:true,force:true});
  }
}
const report={at:new Date().toISOString(),node:process.version,platform:process.platform,note:'Local isolated process including load driver; not a VPS capacity claim.',results};
if(process.argv[2]) {const out=resolve(process.argv[2]);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
