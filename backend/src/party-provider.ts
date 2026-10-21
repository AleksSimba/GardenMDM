import { ApiError } from './validation.js';

const DADATA_URL='https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
export type PartyResult = {
  fields: {full_name:string|null;inn:string;kpp:string|null;legal_address:string|null};
  registry: {
    inn:string;company_type:string;full_legal_name:string|null;short_name:string|null;
    ogrn:string|null;okpo:string|null;okved:string|null;registry_status:string|null;
    registration_date:string|null;actuality_date:string|null;
    management:{name:string|null;post:string|null};
  };
  warnings:string[];
};
export interface PartyProvider {name:string;enabled:boolean;lookup(inn:string):Promise<PartyResult>}
function text(value:unknown,max=5000):string|null {
  return typeof value==='string' && value.trim() && value.trim().length<=max ? value.trim():null;
}
function calendar(value:unknown):string|null {
  if(typeof value!=='number'||!Number.isFinite(value))return null;
  const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString().slice(0,10):null;
}
export function normalizeDadata(body:unknown,inn:string):PartyResult {
  if(!body||typeof body!=='object'||!Array.isArray((body as any).suggestions))throw new ApiError(502,'LOOKUP_INVALID_RESPONSE','Сервис реквизитов вернул некорректный ответ');
  const expectedType=inn.length===10?'LEGAL':'INDIVIDUAL';
  const matches=(body as any).suggestions.filter((s:any)=>s?.data?.inn===inn && s.data.type===expectedType && s.data.branch_type!=='BRANCH');
  if(matches.length===0){
    if((body as any).suggestions.length)throw new ApiError(502,'LOOKUP_MISMATCH','Сервис вернул другую организацию или филиал. Данные не применены');
    throw new ApiError(404,'LOOKUP_NOT_FOUND','Организация или ИП с таким ИНН не найдены');
  }
  const unique=new Map(matches.map((s:any)=>[JSON.stringify([s.data.inn,s.data.kpp,s.data.ogrn]),s]));
  if(unique.size!==1)throw new ApiError(409,'LOOKUP_AMBIGUOUS','Найдено несколько головных записей. Заполните реквизиты вручную');
  const source:any=[...unique.values()][0],data=source.data;
  const full=text(data.name?.full_with_opf),short=text(data.name?.short_with_opf,255);
  const display=full&&full.length<=255?full:short;
  const kpp=inn.length===10&&typeof data.kpp==='string'&&/^\d{9}$/.test(data.kpp)?data.kpp:null;
  const address=text(data.address?.data?.source)||text(data.address?.unrestricted_value)||text(data.address?.value);
  const warnings=['Банковские счета сервис не возвращает. Добавьте и проверьте их вручную.'];
  if(!display)warnings.push('Наименование отсутствует или превышает допустимую длину. Заполните его вручную.');
  if(full&&full.length>255&&short)warnings.push('Для поля наименования предложено краткое название. Полное сохранится в сведениях из реестра.');
  if(inn.length===10&&!kpp)warnings.push('КПП не получен. Для сохранения организации заполните его вручную.');
  if(!address)warnings.push('Адрес не получен. Проверьте его вручную.');
  if(expectedType==='INDIVIDUAL')warnings.push('Для ИП реестр может содержать только населённый пункт, без полного адреса.');
  const status=text(data.state?.status,50);
  if(status!=='ACTIVE')warnings.push('По данным реестра организация не имеет статуса действующей либо статус неизвестен. Проверьте сведения перед созданием.');
  if(data.invalid===true||data.address?.invalidity)warnings.push('В реестре есть отметка о недостоверности сведений. Требуется ручная проверка.');
  return {
    fields:{full_name:display,inn,kpp,legal_address:address},
    registry:{inn,company_type:expectedType,full_legal_name:full,short_name:short,
      ogrn:text(data.ogrn,15),okpo:text(data.okpo,20),okved:text(data.okved,20),registry_status:status,
      registration_date:calendar(data.state?.registration_date),actuality_date:calendar(data.state?.actuality_date),
      management:{name:text(data.management?.name,255),post:text(data.management?.post,255)}},
    warnings
  };
}
export function createDadataProvider(options:{token?:string;fetcher?:typeof fetch;timeoutMs?:number}={}):PartyProvider {
  const token=options.token?.trim();const fetcher=options.fetcher??fetch;
  return {name:'dadata',enabled:!!token,async lookup(inn){
    if(!token)throw new ApiError(503,'LOOKUP_NOT_CONFIGURED','Заполнение по ИНН ещё не подключено. Доступен ручной ввод');
    let response:Response;
    try {
      response=await fetcher(DADATA_URL,{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':`Token ${token}`},
        body:JSON.stringify({query:inn,count:10,branch_type:'MAIN',type:inn.length===10?'LEGAL':'INDIVIDUAL'}),
        signal:AbortSignal.timeout(options.timeoutMs??7000)});
    }catch(e){
      const name=e instanceof Error?e.name:'';
      if(name==='TimeoutError'||name==='AbortError')throw new ApiError(504,'LOOKUP_TIMEOUT','Сервис реквизитов не ответил вовремя. Повторите поиск или заполните вручную');
      throw new ApiError(503,'LOOKUP_UNAVAILABLE','Сервис реквизитов временно недоступен. Доступен ручной ввод');
    }
    if(response.status===401||response.status===403){await response.body?.cancel();throw new ApiError(503,'LOOKUP_ACCESS_DENIED','Сервис не разрешил запрос. Проверьте ключ, тариф и дневной лимит');}
    if(response.status===429){await response.body?.cancel();throw new ApiError(429,'LOOKUP_PROVIDER_LIMIT','Превышен лимит сервиса реквизитов. Повторите позже');}
    if(!response.ok){await response.body?.cancel();throw new ApiError(503,'LOOKUP_UNAVAILABLE','Сервис реквизитов временно недоступен. Доступен ручной ввод');}
    let body:unknown;
    try {
      // Do not retain an unbounded upstream response, or any error body containing credentials.
      const reader=response.body?.getReader();if(!reader)throw Error();const chunks:Uint8Array[]=[];let size=0;
      while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>1024*1024){await reader.cancel();throw Error();}chunks.push(item.value);}
      body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw new ApiError(502,'LOOKUP_INVALID_RESPONSE','Сервис реквизитов вернул некорректный ответ');}
    return normalizeDadata(body,inn);
  }};
}
