import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { ZodError, z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, transaction } from './db.js';
import { ApiError, invalid, uuid, statuses, listing, contractorCreate, contractorPatch, accountCreate, accountPatch, projectSchema, projectPatch } from './validation.js';

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '256kb' }));
export let ready = false;
export function setReady(value: boolean) { ready=value; }
const notFound = () => new ApiError(404,'NOT_FOUND','Запись не найдена');
const conflict = (message:string) => new ApiError(409,'BUSINESS_RULE',message);
const idOf = (value:unknown) => uuid.parse(value);
const contractorSort=['full_name','inn','status','created_at','updated_at'];
const projectSort=['name','city','start_date','end_date','created_at','updated_at'];
const transitions:Record<string,string[]> = {
  PENDING_REVIEW:['ACTIVE','REJECTED','ARCHIVED'], ACTIVE:['ARCHIVED'],
  REJECTED:['PENDING_REVIEW','ARCHIVED'], ARCHIVED:['PENDING_REVIEW'], MERGED:[]
};
async function lockContractor(c:PoolClient,id:string) {
  const r=await c.query('SELECT * FROM contractors WHERE id=$1 FOR UPDATE',[id]);
  if(!r.rowCount) throw notFound(); return r.rows[0];
}
async function contractorDetail(c:PoolClient,id:string) {
  const r=await c.query('SELECT * FROM contractors WHERE id=$1',[id]); if(!r.rowCount) throw notFound();
  const accounts=await c.query('SELECT * FROM contractor_bank_accounts WHERE contractor_id=$1 ORDER BY is_primary DESC,created_at,id',[id]);
  return {...r.rows[0],bank_accounts:accounts.rows};
}
async function insertAccount(c:PoolClient,cid:string,data:z.infer<typeof accountCreate>,primary:boolean) {
  return (await c.query(`INSERT INTO contractor_bank_accounts(contractor_id,bank_name,bik,account_number,correspondent_account,currency,is_primary)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[cid,data.bank_name,data.bik,data.account_number,data.correspondent_account??null,data.currency,primary])).rows[0];
}
async function update(c:PoolClient,table:string,id:string,values:Record<string,unknown>) {
  const entries=Object.entries(values);
  // table names and object keys only come from internal constants and strict schemas.
  return (await c.query(`UPDATE ${table} SET ${entries.map(([k],i)=>`${k}=$${i+2}`).join(',')} WHERE id=$1 RETURNING *`,
    [id,...entries.map(([k,v])=>k==='tep'?JSON.stringify(v):v)])).rows[0];
}
async function listResult(table:string,where:string[],params:unknown[],sort:string,order:string,page:number,limit:number,select='t.*',joins='') {
  return transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const filter=where.length?`WHERE ${where.join(' AND ')}`:'';
    const total=Number((await c.query(`SELECT count(*) FROM ${table} t ${filter}`,params)).rows[0].count);
    const result=await c.query(`SELECT ${select} FROM ${table} t ${joins} ${filter} ORDER BY t.${sort} ${order},t.id ${order} LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,(page-1)*limit]);
    return {data:result.rows,pagination:{page,limit,total,total_pages:Math.ceil(total/limit)}};
  });
}

app.get('/api/health/live',(_req,res)=>res.json({status:'ok'}));
app.get('/api/health/ready',async (_req,res)=>{
  try { if(!ready) throw Error(); await pool.query('SELECT 1'); res.json({status:'ready'}); }
  catch { res.status(503).json({error:{code:'NOT_READY',message:'База данных временно недоступна'}}); }
});
app.get('/api/summary',async (_req,res)=>{
  const r=await pool.query(`SELECT (SELECT count(*)::int FROM contractors) AS contractors,
    (SELECT count(*)::int FROM contractors WHERE status='PENDING_REVIEW') AS pending,
    (SELECT count(*)::int FROM projects) AS projects,
    (SELECT count(*)::int FROM contractor_bank_accounts) AS accounts`);
  res.json({data:r.rows[0]});
});
app.get('/api/contractors',async (req,res)=>{
  const q=listing(req.query,contractorSort,['status']); const where:string[]=[],p:unknown[]=[];
  if(q.string('status')) { const status=z.enum(statuses).parse(q.string('status')); p.push(status); where.push(`t.status=$${p.length}`); }
  if(q.search) { p.push(`%${q.search}%`); where.push(`(t.full_name ILIKE $${p.length} OR t.inn ILIKE $${p.length})`); }
  res.json(await listResult('contractors',where,p,q.sort,q.order,q.page,q.limit));
});
app.get('/api/contractors/:id',async(req,res)=>{
  const id=idOf(req.params.id); res.json({data:await transaction(c=>contractorDetail(c,id))});
});
app.post('/api/contractors',async(req,res)=>{
  const v=contractorCreate.parse(req.body);
  const data=await transaction(async c=>{
    const r=await c.query('INSERT INTO contractors(full_name,inn,kpp,legal_address) VALUES($1,$2,$3,$4) RETURNING id',[v.full_name,v.inn,v.kpp??null,v.legal_address??null]);
    const id=r.rows[0].id; const chosen=Math.max(0,v.bank_accounts.findIndex(a=>a.is_primary));
    for(let i=0;i<v.bank_accounts.length;i++) await insertAccount(c,id,v.bank_accounts[i],i===chosen);
    return contractorDetail(c,id);
  }); res.status(201).json({data});
});
app.patch('/api/contractors/:id',async(req,res)=>{
  const id=idOf(req.params.id),v=contractorPatch.parse(req.body);
  const data=await transaction(async c=>{
    const old=await lockContractor(c,id); const kpp=v.kpp===undefined?old.kpp:v.kpp;
    if(old.inn.length===10 && !kpp) invalid('kpp','Для организации КПП обязателен');
    if(old.inn.length===12 && kpp) invalid('kpp','Для ИНН из 12 цифр КПП не заполняется');
    await update(c,'contractors',id,v); return contractorDetail(c,id);
  }); res.json({data});
});
app.patch('/api/contractors/:id/status',async(req,res)=>{
  const id=idOf(req.params.id),{status}=z.object({status:z.enum(statuses)}).strict().parse(req.body);
  const data=await transaction(async c=>{
    const old=await lockContractor(c,id);
    if(status==='MERGED') throw conflict('Объединение в этой версии недоступно');
    if(old.status!==status && !transitions[old.status]?.includes(status)) throw conflict('Такой переход статуса запрещён');
    if(old.status!==status) await update(c,'contractors',id,{status});
    return contractorDetail(c,id);
  }); res.json({data});
});
app.post('/api/contractors/:id/bank-accounts',async(req,res)=>{
  const id=idOf(req.params.id),v=accountCreate.parse(req.body);
  const data=await transaction(async c=>{
    await lockContractor(c,id);
    if(v.is_primary) await c.query('UPDATE contractor_bank_accounts SET is_primary=false WHERE contractor_id=$1 AND is_primary',[id]);
    return insertAccount(c,id,v,v.is_primary??false);
  }); res.status(201).json({data});
});
app.patch('/api/contractors/:id/bank-accounts/:accountId',async(req,res)=>{
  const id=idOf(req.params.id),aid=idOf(req.params.accountId),v=accountPatch.parse(req.body);
  const data=await transaction(async c=>{
    await lockContractor(c,id);
    if(!(await c.query('SELECT 1 FROM contractor_bank_accounts WHERE id=$1 AND contractor_id=$2',[aid,id])).rowCount) throw notFound();
    return update(c,'contractor_bank_accounts',aid,v);
  }); res.json({data});
});
app.patch('/api/contractors/:id/bank-accounts/:accountId/primary',async(req,res)=>{
  const id=idOf(req.params.id),aid=idOf(req.params.accountId);
  z.object({}).strict().parse(req.body??{});
  const data=await transaction(async c=>{
    await lockContractor(c,id);
    if(!(await c.query('SELECT 1 FROM contractor_bank_accounts WHERE id=$1 AND contractor_id=$2',[aid,id])).rowCount) throw notFound();
    await c.query('UPDATE contractor_bank_accounts SET is_primary=false WHERE contractor_id=$1 AND is_primary',[id]);
    return update(c,'contractor_bank_accounts',aid,{is_primary:true});
  }); res.json({data});
});
app.delete('/api/contractors/:id/bank-accounts/:accountId',async(req,res)=>{
  const id=idOf(req.params.id),aid=idOf(req.params.accountId);
  const query=z.object({replacement_primary_id:uuid.optional()}).strict().parse(req.query);
  await transaction(async c=>{
    await lockContractor(c,id);
    const rows=(await c.query('SELECT * FROM contractor_bank_accounts WHERE contractor_id=$1',[id])).rows;
    const account=rows.find(a=>a.id===aid); if(!account) throw notFound();
    if(rows.length===1) throw conflict('Нельзя удалить последний банковский счёт');
    if(account.is_primary) {
      const replacement=rows.find(a=>a.id===query.replacement_primary_id && a.id!==aid);
      if(!replacement) throw conflict('Выберите другой счёт основным перед удалением');
      await c.query('DELETE FROM contractor_bank_accounts WHERE id=$1',[aid]);
      await update(c,'contractor_bank_accounts',replacement.id,{is_primary:true});
    } else { await c.query('DELETE FROM contractor_bank_accounts WHERE id=$1',[aid]); }
  }); res.status(204).end();
});

const projectSelect=`t.*,jsonb_build_object('id',cu.id,'full_name',cu.full_name,'status',cu.status) AS customer,
 CASE WHEN mi.id IS NULL THEN NULL ELSE jsonb_build_object('id',mi.id,'full_name',mi.full_name,'status',mi.status) END AS intermediary,
 jsonb_build_object('id',co.id,'full_name',co.full_name,'status',co.status) AS contractor`;
const projectJoins='JOIN contractors cu ON cu.id=t.customer_id LEFT JOIN contractors mi ON mi.id=t.intermediary_id JOIN contractors co ON co.id=t.contractor_id';
async function projectDetail(c:PoolClient,id:string) {
  const r=await c.query(`SELECT ${projectSelect} FROM projects t ${projectJoins} WHERE t.id=$1`,[id]);
  if(!r.rowCount) throw notFound(); return r.rows[0];
}
async function validateParticipants(c:PoolClient,v:Record<string,unknown>,old?:Record<string,unknown>) {
  const fields=['customer_id','intermediary_id','contractor_id'];
  const changed=fields.filter(k=>v[k] && (!old || v[k]!==old[k]));
  const ids=[...new Set(changed.map(k=>v[k] as string))].sort();
  if(!ids.length) return;
  // Same lock order for all project requests; status updates take the same row lock.
  const rows=(await c.query('SELECT id,status FROM contractors WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
  for(const k of changed) {
    const person=rows.find(r=>r.id===v[k]);
    if(!person) invalid(k,'Контрагент не найден');
    if(person.status!=='ACTIVE') throw new ApiError(409,'INACTIVE_PARTICIPANT','Можно назначить только активного контрагента',{[k]:'Выберите активного контрагента'});
  }
}
app.get('/api/projects',async(req,res)=>{
  const q=listing(req.query,projectSort,['city','customer_id','intermediary_id','contractor_id']); const where:string[]=[],p:unknown[]=[];
  if(q.search) { p.push(`%${q.search}%`); where.push(`(t.name ILIKE $${p.length} OR t.address ILIKE $${p.length} OR t.city ILIKE $${p.length})`); }
  for(const key of ['city','customer_id','intermediary_id','contractor_id']) if(q.string(key)) {
    const val=q.string(key); if(key!=='city') idOf(val); else if(val.length>120) invalid(key,'Максимум 120 символов');
    p.push(val); where.push(`t.${key}=$${p.length}`);
  }
  res.json(await listResult('projects',where,p,q.sort,q.order,q.page,q.limit,projectSelect,projectJoins));
});
app.get('/api/projects/:id',async(req,res)=>res.json({data:await transaction(c=>projectDetail(c,idOf(req.params.id)))}));
app.post('/api/projects',async(req,res)=>{
  const v=projectSchema.parse(req.body); if(v.end_date<v.start_date) invalid('end_date','Окончание не может быть раньше начала');
  const data=await transaction(async c=>{
    await validateParticipants(c,v);
    const r=await c.query(`INSERT INTO projects(name,address,city,tep,customer_id,intermediary_id,contractor_id,start_date,end_date)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[v.name,v.address,v.city,JSON.stringify(v.tep),v.customer_id,v.intermediary_id??null,v.contractor_id,v.start_date,v.end_date]);
    return projectDetail(c,r.rows[0].id);
  }); res.status(201).json({data});
});
app.patch('/api/projects/:id',async(req,res)=>{
  const id=idOf(req.params.id),v=projectPatch.parse(req.body);
  const data=await transaction(async c=>{
    const r=await c.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[id]); if(!r.rowCount) throw notFound();
    const old=r.rows[0],next={...old,...v};
    if(next.end_date<next.start_date) invalid('end_date','Окончание не может быть раньше начала');
    await validateParticipants(c,v,old); await update(c,'projects',id,v); return projectDetail(c,id);
  }); res.json({data});
});
app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'API-маршрут не найден'}}));
const handler:ErrorRequestHandler=(err,_req,res,_next)=>{
  if(err instanceof ZodError) {
    const fields:Record<string,string>={};
    for(const issue of err.issues) fields[issue.path.join('.')||'_form']=issue.code==='unrecognized_keys'?'Переданы неизвестные или защищённые поля':issue.message;
    res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Проверьте заполнение полей',fields}}); return;
  }
  if(err instanceof ApiError) { res.status(err.status).json({error:{code:err.code,message:err.message,...(err.fields?{fields:err.fields}:{})}}); return; }
  if(err.type==='entity.parse.failed') {res.status(400).json({error:{code:'INVALID_JSON',message:'Некорректный JSON'}});return;}
  if(err.type==='entity.too.large') {res.status(400).json({error:{code:'BODY_TOO_LARGE',message:'Слишком большой запрос'}});return;}
  if(err.code==='23505') {
    const isInn=err.constraint==='contractors_inn_key';
    res.status(409).json({error:{code:isInn?'DUPLICATE_INN':'DUPLICATE_ACCOUNT',message:isInn?'Контрагент с таким ИНН уже существует':'Такой банковский счёт уже существует',fields:isInn?{inn:'ИНН уже используется'}:undefined}}); return;
  }
  if(['23503','23514','23502','22007','22008','22P02'].includes(err.code)) {
    res.status(409).json({error:{code:'CONSTRAINT_VIOLATION',message:'Операция нарушает ограничения данных'}}); return;
  }
  if(['ECONNREFUSED','ETIMEDOUT','57P01','57P03','53300','08006'].includes(err.code)) {
    res.status(503).json({error:{code:'DATABASE_UNAVAILABLE',message:'База данных временно недоступна'}}); return;
  }
  console.error('Request failed', {name:err.name,code:err.code??'UNEXPECTED'});
  res.status(500).json({error:{code:'INTERNAL_ERROR',message:'Внутренняя ошибка сервера'}});
};
app.use(handler);
