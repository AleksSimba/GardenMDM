import { z } from 'zod';
z.setErrorMap((issue) => {
  const messages: Record<string,string> = {
    invalid_type: 'Неверный тип значения или не заполнено обязательное поле',
    invalid_enum_value: 'Выберите значение из допустимого списка',
    invalid_string: 'Некорректный формат значения',
    too_small: 'Значение меньше допустимого или поле не заполнено',
    too_big: 'Превышен допустимый размер значения',
    not_finite: 'Ожидается конечное число',
    unrecognized_keys: 'Переданы неизвестные или защищённые поля'
  };
  return {message:messages[issue.code]??'Некорректное значение'};
});
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string,string>) { super(message); }
}
export function invalid(field: string, message: string): never {
  throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте заполнение полей', { [field]: message });
}
export const uuid = z.string().uuid('Некорректный UUID');
export const statuses = ['PENDING_REVIEW','ACTIVE','REJECTED','MERGED','ARCHIVED'] as const;
const name = z.string().trim().min(2, 'Минимум 2 символа').max(255, 'Максимум 255 символов');
const optionalText = z.preprocess(v => typeof v === 'string' ? v.trim() || null : v, z.string().max(5000).nullable());
const kpp = z.preprocess(v => v === '' ? null : v, z.string().regex(/^\d{9}$/, 'КПП должен содержать 9 цифр').nullable());
export function validInn(s: string): boolean {
  if (!/^(\d{10}|\d{12})$/.test(s)) return false;
  const a = [...s].map(Number);
  const checksum = (weights: number[]) => weights.reduce((sum, w, i) => sum + w * a[i], 0) % 11 % 10;
  return s.length === 10 ? checksum([2,4,10,3,5,9,4,6,8]) === a[9]
    : checksum([7,2,4,10,3,5,9,4,6,8]) === a[10] && checksum([3,7,2,4,10,3,5,9,4,6,8]) === a[11];
}
export const accountFields = {
  bank_name: name,
  bik: z.string().regex(/^\d{9}$/, 'БИК должен содержать 9 цифр'),
  account_number: z.string().regex(/^\d{20}$/, 'Номер счёта должен содержать 20 цифр'),
  correspondent_account: z.preprocess(v => v === '' ? null : v, z.string().regex(/^\d{20}$/, 'Требуется 20 цифр').nullable()).optional(),
  currency: z.enum(['RUB','USD','EUR','CNY']).default('RUB')
};
export const accountCreate = z.object({ ...accountFields, is_primary: z.boolean().optional() }).strict();
export const accountPatch = z.object(accountFields).partial().strict().refine(v => Object.keys(v).length>0, 'Нет полей для изменения');
export const contractorCreate = z.object({
  full_name: name,
  inn: z.string().refine(validInn, 'Некорректный ИНН: требуется 10 или 12 цифр и верные контрольные разряды'),
  kpp: kpp.optional(), legal_address: optionalText.optional(),
  bank_accounts: z.array(accountCreate).min(1, 'Добавьте хотя бы один банковский счёт').max(100)
}).strict().superRefine((v, ctx) => {
  if (v.inn.length===10 && !v.kpp) ctx.addIssue({ code: 'custom', path:['kpp'], message:'Для организации КПП обязателен' });
  if (v.inn.length===12 && v.kpp) ctx.addIssue({ code:'custom', path:['kpp'], message:'Для ИНН из 12 цифр КПП не заполняется' });
  if (v.bank_accounts.filter(a=>a.is_primary).length>1) ctx.addIssue({ code:'custom', path:['bank_accounts'], message:'Выберите только один основной счёт' });
});
export const contractorPatch = z.object({ full_name: name.optional(), kpp: kpp.optional(), legal_address: optionalText.optional() }).strict()
  .refine(v=>Object.keys(v).length>0, 'Нет полей для изменения');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: ГГГГ-ММ-ДД').refine(v => {
  const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===v && v>='0001-01-01';
}, 'Некорректная дата');
const tep = z.array(z.object({ name: z.string().trim().min(1).max(255), value: z.number().finite().nonnegative(), unit:z.string().trim().min(1).max(60) }).strict()).max(100)
  .refine(v=>new Set(v.map(i=>i.name.toLocaleLowerCase('ru'))).size===v.length, 'Названия ТЭП не должны повторяться');
export const projectSchema = z.object({ name, address:z.string().trim().min(1).max(5000), city:z.string().trim().min(1).max(120),
  tep:tep.default([]), customer_id:uuid, intermediary_id:uuid.nullable().optional(), contractor_id:uuid, start_date:date, end_date:date }).strict();
export const projectPatch = projectSchema.partial().strict().refine(v=>Object.keys(v).length>0, 'Нет полей для изменения');
export function listing(query: Record<string, unknown>, sortKeys: string[], filterKeys: string[]) {
  const allowed = ['page','limit','search','sort_by','sort_order',...filterKeys];
  for (const k of Object.keys(query)) if (!allowed.includes(k)) invalid(k, 'Неизвестный параметр');
  function string(key: string, fallback='') { const v=query[key]; if(v===undefined) return fallback; if(typeof v!=='string') invalid(key,'Ожидается строка'); return v; }
  function integer(key:string, fallback:number, max:number) { const v=string(key,String(fallback)); if(!/^[1-9]\d*$/.test(v) || Number(v)>max) invalid(key,`Целое число от 1 до ${max}`); return Number(v); }
  const page=integer('page',1,1000000), limit=integer('limit',20,100);
  const sort=string('sort_by','created_at'), order=string('sort_order','desc');
  if(!sortKeys.includes(sort)) invalid('sort_by','Недопустимое поле сортировки');
  if(!['asc','desc'].includes(order)) invalid('sort_order','Допустимы asc и desc');
  const search=string('search').trim(); if(search.length>255) invalid('search','Максимум 255 символов');
  return {page,limit,sort,order,search:search.replace(/[\\%_]/g,'\\$&'),string};
}
