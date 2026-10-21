import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, setReady } from '../dist/app.js';
import { pool, migrate } from '../dist/db.js';
import { createDadataProvider, normalizeDadata } from '../dist/party-provider.js';
import { setRegistryProviderForTests } from '../dist/party-lookup.js';

if(process.env.PGDATABASE!=='mdm_test')throw Error('Isolated test database required');
let server,base,sequence=1;
function nextInn(){const base=`99003${String(sequence++).padStart(4,'0')}`;const w=[2,4,10,3,5,9,4,6,8];return base+([...base].reduce((s,d,i)=>s+Number(d)*w[i],0)%11%10);}
function fixture(inn,extra={}){return {suggestions:[{data:{inn,type:inn.length===10?'LEGAL':'INDIVIDUAL',branch_type:'MAIN',kpp:inn.length===10?'990301001':null,ogrn:'1029900000001',name:{full_with_opf:'Общество с ограниченной ответственностью «Тест поиска»',short_with_opf:'ООО «Тест поиска»'},address:{data:{source:'Демонстрационный адрес из реестра'}},state:{status:'ACTIVE',registration_date:Date.UTC(2020,0,1),actuality_date:Date.UTC(2026,9,1)},management:{name:'Тестовый руководитель',post:'Директор'},okpo:'12345678',okved:'41.20',...extra}}]};}
async function request(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
function fakeProvider(lookup){setRegistryProviderForTests({name:'dadata',enabled:true,lookup});}
before(async()=>{await migrate();await pool.query('TRUNCATE party_lookup_cache');setReady(true);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/api`;});
after(async()=>{await new Promise(r=>server.close(r));await pool.end();});

test('provider sends only exact INN, MAIN and type with server authorization',async()=>{
  const inn=nextInn();let called=false;const provider=createDadataProvider({token:'fake-test-key-not-a-secret',fetcher:async(url,options)=>{
    called=true;assert.equal(url,'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party');assert.equal(options.headers.Authorization,'Token fake-test-key-not-a-secret');assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{query:inn,count:10,branch_type:'MAIN',type:'LEGAL'});return new Response(JSON.stringify(fixture(inn)));}});
  const result=await provider.lookup(inn);assert.ok(called);assert.equal(result.fields.inn,inn);assert.equal(result.fields.kpp,'990301001');assert.equal(result.registry.ogrn,'1029900000001');assert.equal(result.registry.registration_date,'2020-01-01');assert.equal(result.bank_accounts,undefined);
});
test('12-digit INN keeps empty KPP and warns about incomplete IP address',()=>{
  const inn='784806113663',r=normalizeDadata(fixture(inn,{kpp:'990301001'}),inn);assert.equal(r.fields.kpp,null);assert.equal(r.registry.company_type,'INDIVIDUAL');assert.ok(r.warnings.some(w=>w.includes('населённый пункт')));
});
test('normalization never silently chooses a different INN, branch or ambiguous head',()=>{
  const inn=nextInn();assert.throws(()=>normalizeDadata(fixture(nextInn()),inn),e=>e.code==='LOOKUP_MISMATCH');
  assert.throws(()=>normalizeDadata(fixture(inn,{branch_type:'BRANCH'}),inn),e=>e.code==='LOOKUP_MISMATCH');
  const f=fixture(inn);f.suggestions.push(fixture(inn,{kpp:'990302001'}).suggestions[0]);assert.throws(()=>normalizeDadata(f,inn),e=>e.code==='LOOKUP_AMBIGUOUS');
  assert.throws(()=>normalizeDadata({suggestions:[]},inn),e=>e.code==='LOOKUP_NOT_FOUND');assert.throws(()=>normalizeDadata({},inn),e=>e.code==='LOOKUP_INVALID_RESPONSE');
});
test('missing fields and long legal names are not fabricated or silently truncated',()=>{
  const inn=nextInn(),long='Наименование '.repeat(40);const r=normalizeDadata(fixture(inn,{name:{full_with_opf:long,short_with_opf:'ООО Краткое'},kpp:null,address:null,state:{status:'LIQUIDATED'},invalid:true}),inn);
  assert.equal(r.fields.full_name,'ООО Краткое');assert.equal(r.registry.full_legal_name,long.trim());assert.equal(r.fields.kpp,null);assert.equal(r.fields.legal_address,null);assert.ok(r.warnings.length>=5);
});
test('upstream permission, quota, failure and malformed body expose no response details',async()=>{
  for(const [status,expected]of [[401,'LOOKUP_ACCESS_DENIED'],[403,'LOOKUP_ACCESS_DENIED'],[429,'LOOKUP_PROVIDER_LIMIT'],[500,'LOOKUP_UNAVAILABLE']]){
    const p=createDadataProvider({token:'fake-test-key',fetcher:async()=>new Response('upstream-private-diagnostic',{status})});await assert.rejects(p.lookup(nextInn()),e=>e.code===expected&&!e.message.includes('upstream-private'));
  }
  const bad=createDadataProvider({token:'fake-test-key',fetcher:async()=>new Response('not-json')});await assert.rejects(bad.lookup(nextInn()),e=>e.code==='LOOKUP_INVALID_RESPONSE');
  const huge=createDadataProvider({token:'fake-test-key',fetcher:async()=>new Response('x'.repeat(1024*1024+1))});await assert.rejects(huge.lookup(nextInn()),e=>e.code==='LOOKUP_INVALID_RESPONSE');
});
test('upstream timeout and missing key are explicit and leave manual entry possible',async()=>{
  const timed=createDadataProvider({token:'fake-test-key',timeoutMs:10,fetcher:async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))});
  await assert.rejects(timed.lookup(nextInn()),e=>e.code==='LOOKUP_TIMEOUT');await assert.rejects(createDadataProvider().lookup(nextInn()),e=>e.code==='LOOKUP_NOT_CONFIGURED');
});
test('disabled integration reports configuration without revealing secrets',async()=>{
  setRegistryProviderForTests({name:'dadata',enabled:false,lookup:async()=>{throw Error('Must not call');}});
  const status=await request('/integrations/inn/status');assert.equal(status.status,200);assert.equal(status.body.data.enabled,false);assert.equal(status.body.data.bank_accounts_available,false);assert.equal(status.body.data.token,undefined);
  const r=await request('/contractors/lookup-by-inn','POST',{inn:nextInn()});assert.equal(r.status,503);assert.equal(r.body.error.code,'LOOKUP_NOT_CONFIGURED');
});
test('lookup validates INN before provider and rejects arbitrary request fields',async()=>{
  let calls=0;fakeProvider(async inn=>{calls++;return normalizeDadata(fixture(inn),inn);});
  for(const body of [{inn:'123'},{inn:'12345678901'},{inn:'1234567890'},{inn:nextInn(),url:'http://internal-host'},{inn:nextInn(),token:'client-supplied-key'}])assert.equal((await request('/contractors/lookup-by-inn','POST',body)).status,400);
  assert.equal(calls,0);
});
test('successful lookup is cached and simultaneous repeated INNs use one external call',async()=>{
  const inn=nextInn();let calls=0;fakeProvider(async q=>{calls++;return normalizeDadata(fixture(q),q);});
  const result=await Promise.all(Array.from({length:5},()=>request('/contractors/lookup-by-inn','POST',{inn})));
  assert.ok(result.every(r=>r.status===200));assert.equal(calls,1);assert.equal(new Set(result.map(r=>r.body.data.lookup_id)).size,1);
  const repeated=await request('/contractors/lookup-by-inn','POST',{inn});assert.equal(repeated.body.data.cached,true);assert.equal(calls,1);
});
test('confirmed lookup is bound to contractor server-side; accounts still mandatory and status stays pending',async()=>{
  fakeProvider(async inn=>normalizeDadata(fixture(inn,{state:{status:'LIQUIDATED'}}),inn));const inn=nextInn();const lookup=(await request('/contractors/lookup-by-inn','POST',{inn})).body.data;
  const payload={...lookup.fields,lookup_id:lookup.lookup_id,bank_accounts:[]};assert.equal((await request('/contractors','POST',payload)).status,400);
  payload.bank_accounts=[{bank_name:'Тестовый банк',bik:'044000001',account_number:'40702810000000000099',currency:'RUB'}];
  const created=await request('/contractors','POST',payload);assert.equal(created.status,201,JSON.stringify(created.body));const c=created.body.data;assert.equal(c.status,'PENDING_REVIEW');assert.equal(c.registry_snapshot.provider,'dadata');assert.equal(c.registry_snapshot.inn,inn);assert.equal(c.registry_snapshot.registry_status,'LIQUIDATED');
  assert.equal((await request(`/contractors/${c.id}`)).body.data.registry_snapshot.ogrn,'1029900000001');
  assert.equal((await request(`/contractors/${c.id}`,'PATCH',{registry_snapshot:{provider:'forged'}})).status,400);
  const duplicate=await request('/contractors/lookup-by-inn','POST',{inn});assert.equal(duplicate.status,409);assert.equal(duplicate.body.error.code,'DUPLICATE_INN');
});
test('lookup cannot be attached to a different INN and expired results require refresh',async()=>{
  fakeProvider(async inn=>normalizeDadata(fixture(inn),inn));const inn=nextInn();const lookup=(await request('/contractors/lookup-by-inn','POST',{inn})).body.data;
  const payload={...lookup.fields,inn:nextInn(),lookup_id:lookup.lookup_id,bank_accounts:[{bank_name:'Тестовый банк',bik:'044000001',account_number:'40702810000000000100'}]};
  assert.equal((await request('/contractors','POST',payload)).status,409);
  await pool.query("UPDATE party_lookup_cache SET fetched_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[lookup.lookup_id]);
  const expired=await request('/contractors','POST',{...payload,inn});assert.equal(expired.status,409);assert.equal(expired.body.error.code,'LOOKUP_EXPIRED');
});
test('failed lookups are not cached and provider exceptions remain user-readable',async()=>{
  let calls=0;const inn=nextInn();fakeProvider(async q=>{calls++;return normalizeDadata({suggestions:[]},q);});
  for(let i=0;i<2;i++){const r=await request('/contractors/lookup-by-inn','POST',{inn});assert.equal(r.status,404);assert.equal(r.body.error.code,'LOOKUP_NOT_FOUND');}assert.equal(calls,2);
  assert.equal((await pool.query('SELECT 1 FROM party_lookup_cache WHERE inn=$1',[inn])).rowCount,0);
});
test('local outbound rate limit protects quota and cached results remain available',async()=>{
  const first=nextInn();fakeProvider(async inn=>normalizeDadata(fixture(inn),inn));
  for(let i=0;i<30;i++)assert.equal((await request('/contractors/lookup-by-inn','POST',{inn:i===0?first:nextInn()})).status,200);
  assert.equal((await request('/contractors/lookup-by-inn','POST',{inn:nextInn()})).status,429);
  assert.equal((await request('/contractors/lookup-by-inn','POST',{inn:first})).status,200);
});
