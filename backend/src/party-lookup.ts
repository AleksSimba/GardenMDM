import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { ApiError } from './validation.js';
import { createDadataProvider,type PartyProvider,type PartyResult } from './party-provider.js';

const configured=process.env.INN_LOOKUP_PROVIDER??(process.env.DADATA_API_KEY?'dadata':'none');
let provider:PartyProvider=configured==='dadata'?createDadataProvider({token:process.env.DADATA_API_KEY}):{
  name:'none',enabled:false,async lookup(){throw new ApiError(503,'LOOKUP_NOT_CONFIGURED','Источник реквизитов ещё не подключён');}
};
const pending=new Map<string,Promise<any>>();
let attempts:number[]=[];
export function lookupConfiguration(){return {provider:provider.name,display_name:provider.name==='dadata'?'DaData':null,enabled:provider.enabled,requires_api_key:!provider.enabled,cache_hours:24,bank_accounts_available:false};}
export function setRegistryProviderForTests(value:PartyProvider){
  if(process.env.NODE_ENV!=='test')throw new Error('Test injection is disabled');
  provider=value;attempts=[];pending.clear();
}
function publicResult(row:any,cached:boolean){return {lookup_id:row.id,provider:row.provider,fetched_at:new Date(row.fetched_at).toISOString(),expires_at:new Date(row.expires_at).toISOString(),...row.payload,cached};}
export async function lookupByInn(inn:string){
  if((await pool.query('SELECT 1 FROM contractors WHERE inn=$1',[inn])).rowCount)throw new ApiError(409,'DUPLICATE_INN','Контрагент с таким ИНН уже есть в справочнике',{inn:'Найдите существующую запись по ИНН'});
  if(!provider.enabled)throw new ApiError(503,'LOOKUP_NOT_CONFIGURED','Заполнение по ИНН ещё не подключено. Доступен ручной ввод');
  const cached=await pool.query('SELECT * FROM party_lookup_cache WHERE provider=$1 AND inn=$2 AND expires_at>now() ORDER BY fetched_at DESC,id DESC LIMIT 1',[provider.name,inn]);
  if(cached.rowCount)return publicResult(cached.rows[0],true);
  const running=pending.get(inn);if(running)return running;
  const now=Date.now();attempts=attempts.filter(t=>t>now-60000);
  if(attempts.length>=30)throw new ApiError(429,'LOOKUP_RATE_LIMIT','Слишком много запросов. Подождите минуту');
  if(pending.size>=3)throw new ApiError(429,'LOOKUP_BUSY','Сервис занят обработкой запросов. Повторите через несколько секунд');
  attempts.push(now);
  const selected=provider;
  const task=(async()=>{
    const payload:PartyResult=await selected.lookup(inn);
    const row=(await pool.query('INSERT INTO party_lookup_cache(provider,inn,payload) VALUES($1,$2,$3) RETURNING *',[selected.name,inn,JSON.stringify(payload)])).rows[0];
    await pool.query('DELETE FROM party_lookup_cache WHERE expires_at<=now()');
    return publicResult(row,false);
  })();
  pending.set(inn,task);
  try{return await task;}finally{pending.delete(inn);}
}
export async function snapshotForCreation(c:PoolClient,id:string,inn:string){
  const row=(await c.query('SELECT * FROM party_lookup_cache WHERE id=$1 AND inn=$2 AND expires_at>now() FOR SHARE',[id,inn])).rows[0];
  if(!row)throw new ApiError(409,'LOOKUP_EXPIRED','Результат поиска устарел или относится к другому ИНН. Повторите поиск',{lookup_id:'Требуется новый поиск по ИНН'});
  return {...row.payload.registry,provider:row.provider,fetched_at:new Date(row.fetched_at).toISOString(),suggested_fields:row.payload.fields};
}
