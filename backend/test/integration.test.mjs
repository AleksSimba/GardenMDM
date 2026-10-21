import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { app, setReady } from '../dist/app.js';
import { pool, migrate, seed, transaction } from '../dist/db.js';
import { validInn } from '../dist/validation.js';

if(process.env.PGDATABASE!=='mdm_test')throw new Error('Tests require isolated PGDATABASE=mdm_test');
let server,base,sequence=100;
function inn(length=10){
  const a=[...(length===10?`99001${String(++sequence).padStart(4,'0')}`:`99001${String(++sequence).padStart(5,'0')}`)].map(Number);
  const control=weights=>weights.reduce((s,w,i)=>s+w*a[i],0)%11%10;
  if(length===10)a.push(control([2,4,10,3,5,9,4,6,8]));
  else{a.push(control([7,2,4,10,3,5,9,4,6,8]));a.push(control([3,7,2,4,10,3,5,9,4,6,8]));}
  return a.join('');
}
const account=(n=1,primary)=>({bank_name:'Тестовый банк',bik:'044000001',account_number:`40702810${String(n).padStart(12,'0')}`,currency:'RUB',...(primary===undefined?{}:{is_primary:primary})});
const contractor=(extra={})=>({full_name:`Тестовый контрагент ${sequence}`,inn:inn(),kpp:'990001001',bank_accounts:[account()],...extra});
async function request(path,method='GET',body){
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:r.status===204?null:await r.json()};
}
async function create(extra={}){const r=await request('/contractors','POST',contractor(extra));assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
async function activate(id){const r=await request(`/contractors/${id}/status`,'PATCH',{status:'ACTIVE'});assert.equal(r.status,200);}
before(async()=>{
  await migrate();await migrate();
  await pool.query('TRUNCATE projects,contractor_bank_accounts,contractors CASCADE');
  await pool.query('DROP TABLE IF EXISTS seed_runs');
  setReady(true);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();});

test('health and unknown API route',async()=>{
  assert.equal((await request('/health/live')).status,200);assert.equal((await request('/health/ready')).status,200);
  const r=await request('/missing');assert.equal(r.status,404);assert.equal(r.body.error.code,'NOT_FOUND');
  setReady(false);assert.equal((await request('/health/ready')).status,503);setReady(true);
});
test('contractor creation includes all accounts and selects exactly one primary',async()=>{
  const v=await create({bank_accounts:[account(1),account(2)]});assert.equal(v.status,'PENDING_REVIEW');assert.equal(v.bank_accounts.length,2);assert.equal(v.bank_accounts.filter(a=>a.is_primary).length,1);
  const r=await request(`/contractors/${v.id}`);assert.equal(r.body.data.inn,v.inn);assert.equal(r.body.data.bank_accounts[0].is_primary,true);
});
test('valid 12-digit INN, checksum errors, 11 digits, KPP rules and unknown fields',async()=>{
  const twelve=inn(12);assert.equal(validInn(twelve),true);assert.equal((await create({inn:twelve,kpp:null})).kpp,null);
  for(const extra of [{inn:'12345678901'},{inn:'1234567890'},{kpp:null},{kpp:'123'},{inn:inn(12),kpp:'990001001'},{status:'ACTIVE'},{id:'bad'}]){
    const r=await request('/contractors','POST',contractor(extra));assert.equal(r.status,400,JSON.stringify(r.body));assert.ok(r.body.error.fields);
  }
});
test('no accounts, multiple primaries and invalid account formats are rejected',async()=>{
  for(const bank_accounts of [[],[account(1,true),account(2,true)],[{...account(),bik:'1'}],[{...account(),account_number:'1'}],[{...account(),currency:'GBP'}]]){
    const r=await request('/contractors','POST',contractor({bank_accounts}));assert.equal(r.status,400);
  }
});
test('duplicate INN returns 409 and cannot be changed even to the same value',async()=>{
  const v=await create();const duplicate=await request('/contractors','POST',contractor({inn:v.inn}));assert.equal(duplicate.status,409);assert.equal(duplicate.body.error.code,'DUPLICATE_INN');
  assert.equal((await request(`/contractors/${v.id}`,'PATCH',{inn:v.inn})).status,400);
  assert.equal((await request(`/contractors/${v.id}`,'PATCH',{})).status,400);
  const updated=await request(`/contractors/${v.id}`,'PATCH',{full_name:'  Новое название  ',legal_address:''});assert.equal(updated.status,200);assert.equal(updated.body.data.full_name,'Новое название');assert.equal(updated.body.data.legal_address,null);
});
test('duplicate second bank account rolls back the entire contractor transaction',async()=>{
  const payload=contractor({bank_accounts:[account(8),account(8)]});const r=await request('/contractors','POST',payload);assert.equal(r.status,409);
  assert.equal((await pool.query('SELECT id FROM contractors WHERE inn=$1',[payload.inn])).rowCount,0);
});
test('account membership, immutable parent and protected primary field',async()=>{
  const a=await create(),b=await create(),aid=a.bank_accounts[0].id;
  for(const [suffix,method,body]of [['','PATCH',{bank_name:'Чужой банк'}],['/primary','PATCH',{}],['','DELETE',undefined]]){
    assert.equal((await request(`/contractors/${b.id}/bank-accounts/${aid}${suffix}`,method,body)).status,404);
  }
  assert.equal((await request(`/contractors/${a.id}/bank-accounts/${aid}`,'PATCH',{contractor_id:b.id})).status,400);
  assert.equal((await request(`/contractors/${a.id}/bank-accounts/${aid}`,'PATCH',{is_primary:false})).status,400);
  assert.equal((await request(`/contractors/${a.id}/bank-accounts/${aid}`,'PATCH',{bank_name:'Новый банк'})).body.data.bank_name,'Новый банк');
});
test('last account cannot be deleted; primary replacement is transactional',async()=>{
  const v=await create(),first=v.bank_accounts[0];assert.equal((await request(`/contractors/${v.id}/bank-accounts/${first.id}`,'DELETE')).status,409);
  const added=await request(`/contractors/${v.id}/bank-accounts`,'POST',account(11));assert.equal(added.status,201);
  assert.equal((await request(`/contractors/${v.id}/bank-accounts/${first.id}`,'DELETE')).status,409);
  const r=await request(`/contractors/${v.id}/bank-accounts/${first.id}?replacement_primary_id=${added.body.data.id}`,'DELETE');assert.equal(r.status,204);
  const detail=(await request(`/contractors/${v.id}`)).body.data;assert.equal(detail.bank_accounts.length,1);assert.equal(detail.bank_accounts[0].is_primary,true);
});
test('concurrent primary switches preserve one primary',async()=>{
  const v=await create({bank_accounts:[account(31),account(32),account(33)]});
  const results=await Promise.all(v.bank_accounts.map(a=>request(`/contractors/${v.id}/bank-accounts/${a.id}/primary`,'PATCH',{})));
  assert.ok(results.every(r=>r.status===200));const d=(await request(`/contractors/${v.id}`)).body.data;assert.equal(d.bank_accounts.filter(a=>a.is_primary).length,1);
});
test('concurrent deletion cannot remove the last account',async()=>{
  const v=await create({bank_accounts:[account(41),account(42)]});const a=v.bank_accounts;
  const r=await Promise.all(a.map((x,i)=>request(`/contractors/${v.id}/bank-accounts/${x.id}?replacement_primary_id=${a[1-i].id}`,'DELETE')));
  assert.deepEqual(r.map(x=>x.status).sort(),[204,409]);const d=(await request(`/contractors/${v.id}`)).body.data;assert.equal(d.bank_accounts.length,1);assert.equal(d.bank_accounts[0].is_primary,true);
});
test('database deferred constraints protect writes outside the API',async()=>{
  const number=inn();await assert.rejects(transaction(c=>c.query('INSERT INTO contractors(full_name,inn,kpp) VALUES($1,$2,$3)',['Без счетов',number,'990001001'])),e=>e.code==='23514');
  assert.equal((await pool.query('SELECT 1 FROM contractors WHERE inn=$1',[number])).rowCount,0);
  const v=await create();await assert.rejects(pool.query('DELETE FROM contractor_bank_accounts WHERE contractor_id=$1',[v.id]),e=>e.code==='23514');
  assert.equal((await request(`/contractors/${v.id}`)).body.data.bank_accounts.length,1);
});
test('status transitions, same-state repeat and reserved MERGED',async()=>{
  const v=await create();for(const status of ['PENDING_REVIEW','REJECTED','PENDING_REVIEW','ACTIVE','ACTIVE','ARCHIVED','PENDING_REVIEW'])assert.equal((await request(`/contractors/${v.id}/status`,'PATCH',{status})).status,200);
  assert.equal((await request(`/contractors/${v.id}/status`,'PATCH',{status:'MERGED'})).status,409);
  await activate(v.id);assert.equal((await request(`/contractors/${v.id}/status`,'PATCH',{status:'REJECTED'})).status,409);
});
let project,customer,performer;
test('project creation with active participants and multiple TEP',async()=>{
  customer=await create();performer=await create();await activate(customer.id);await activate(performer.id);
  const r=await request('/projects','POST',{name:'ЖК Тестовый сад',address:'Улица Тестовая, 1',city:'Москва',customer_id:customer.id,contractor_id:performer.id,intermediary_id:null,start_date:'2026-01-01',end_date:'2027-12-31',tep:[{name:'Площадь',value:1234.5,unit:'м²'},{name:'Этажность',value:12,unit:'этажей'}]});
  assert.equal(r.status,201,JSON.stringify(r.body));project=r.body.data;assert.equal(project.customer.full_name,customer.full_name);assert.equal(project.intermediary,null);assert.equal(project.start_date,'2026-01-01');assert.equal(project.tep.length,2);
});
test('project invalid dates, duplicate TEP, inactive and missing participants',async()=>{
  const pending=await create();const payload={name:'Проект',address:'Адрес',city:'Город',customer_id:customer.id,contractor_id:performer.id,start_date:'2026-01-01',end_date:'2027-01-01',tep:[]};
  for(const extra of [{start_date:'2026-02-30'},{end_date:'2025-01-01'},{tep:[{name:'Площадь',value:-1,unit:'м²'}]},{tep:[{name:'Площадь',value:1,unit:'м²'},{name:' площадь ',value:2,unit:'м²'}]},{customer_id:'00000000-0000-4000-8000-000000000000'}])assert.equal((await request('/projects','POST',{...payload,...extra})).status,400);
  assert.equal((await request('/projects','POST',{...payload,customer_id:pending.id})).status,409);
  assert.equal((await request(`/projects/${project.id}`,'PATCH',{end_date:'2025-01-01'})).status,400);
});
test('archived existing participant remains linked and project can still be edited',async()=>{
  assert.equal((await request(`/contractors/${customer.id}/status`,'PATCH',{status:'ARCHIVED'})).status,200);
  const r=await request(`/projects/${project.id}`,'PATCH',{name:'Обновлённый проект',customer_id:customer.id});assert.equal(r.status,200);assert.equal(r.body.data.customer.status,'ARCHIVED');
  assert.equal((await request(`/projects/${project.id}`)).body.data.name,'Обновлённый проект');
});
test('participant assignment and concurrent archiving remain consistent',async()=>{
  const v=await create();await activate(v.id);
  const [assign,archive]=await Promise.all([request(`/projects/${project.id}`,'PATCH',{intermediary_id:v.id}),request(`/contractors/${v.id}/status`,'PATCH',{status:'ARCHIVED'})]);
  assert.equal(archive.status,200);assert.ok([200,409].includes(assign.status));
  const d=(await request(`/projects/${project.id}`)).body.data;assert.equal(d.intermediary_id,assign.status===200?v.id:null);
});
test('pagination, filters, literal wildcard search, sort allowlist and invalid UUID',async()=>{
  const special=await create({full_name:'Процент % _ Тест'});
  const r=await request('/contractors?page=1&limit=2&sort_by=full_name&sort_order=asc');assert.equal(r.status,200);assert.equal(r.body.data.length,2);assert.ok(r.body.pagination.total>2);
  const found=await request('/contractors?search=%25');assert.equal(found.body.pagination.total,1);assert.equal(found.body.data[0].id,special.id);
  assert.equal((await request('/contractors?status=MERGED')).body.pagination.total,0);
  for(const path of ['/contractors?page=0','/contractors?limit=101','/contractors?sort_by=full_name;DROP','/contractors?sort_order=sideways','/contractors?oops=1','/contractors/bad-uuid','/projects?customer_id=bad'])assert.equal((await request(path)).status,400,path);
  const p=await request(`/projects?city=${encodeURIComponent('Москва')}&customer_id=${customer.id}`);assert.equal(p.body.pagination.total,1);
  assert.equal((await request('/contractors/00000000-0000-4000-8000-000000000000')).status,404);
});
test('malformed JSON returns JSON error without internal details',async()=>{
  const r=await fetch(`${base}/contractors`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'});assert.equal(r.status,400);const b=await r.json();assert.equal(b.error.code,'INVALID_JSON');assert.equal(b.error.stack,undefined);
});
test('demo SQL has valid INNs and repeated seed preserves edits',async()=>{
  process.env.SEED_DEMO_DATA='true';await seed();
  const demo=(await pool.query("SELECT * FROM contractors WHERE id::text LIKE '10000000-%'")).rows;assert.equal(demo.length,10);assert.ok(demo.every(c=>validInn(c.inn)));
  await pool.query("UPDATE contractors SET full_name='Изменён пользователем' WHERE id='10000000-0000-4000-8000-000000000001'");await seed();
  assert.equal((await pool.query("SELECT full_name FROM contractors WHERE id='10000000-0000-4000-8000-000000000001'")).rows[0].full_name,'Изменён пользователем');
  const sql=await readFile('database/seed.sql','utf8');await transaction(c=>c.query(sql));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE id::text LIKE '30000000-%'")).rows[0].n,5);
});
