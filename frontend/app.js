'use strict';
const $ = s => document.querySelector(s);
const labels = { PENDING_REVIEW:'На проверке', ACTIVE:'Активен', REJECTED:'Отклонён', MERGED:'Объединён', ARCHIVED:'Архив' };
const transitions = { PENDING_REVIEW:['ACTIVE','REJECTED','ARCHIVED'], ACTIVE:['ARCHIVED'], REJECTED:['PENDING_REVIEW','ARCHIVED'], ARCHIVED:['PENDING_REVIEW'], MERGED:[] };
const state = { tab:'contractors', page:1, limit:20, sort:'created_at', order:'desc', status:'PENDING_REVIEW', search:'', city:'', participants:{}, rows:[], selected:null, total:0, controller:null, request:0, loading:false };
const esc = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const element = (tag, cls, text) => { const n=document.createElement(tag); if(cls) n.className=cls; if(text!==undefined) n.textContent=text; return n; };
function button(text, cls='secondary', action) { const b=element('button',`button ${cls}`,text); b.type='button'; if(action)b.addEventListener('click',action); return b; }
function toast(message,error=false) { const n=element('div',`toast${error?' error':''}`,message); n.setAttribute('role',error?'alert':'status'); $('#toasts').append(n); setTimeout(()=>n.remove(),6500); }
async function api(path, options={}) {
  let response;
  try { response=await fetch(`/api${path}`,{ ...options, headers:{'Content-Type':'application/json',...options.headers} }); }
  catch(e) { if(e.name==='AbortError')throw e; throw new Error('Не удалось связаться с сервером. Проверьте соединение.'); }
  if(response.status===204)return null;
  let body; try{body=await response.json();}catch{throw new Error('Сервер вернул некорректный ответ');}
  if(!response.ok){const e=new Error(body.error?.message||'Не удалось выполнить запрос');e.fields=body.error?.fields;throw e;}
  return body;
}
const send = (path,method,body) => api(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
function date(v) { if(!v)return '—'; if(/^\d{4}-\d{2}-\d{2}$/.test(v)){const [y,m,d]=v.split('-');return `${d}.${m}.${y}`;} return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(v)); }
function badge(status){return `<span class="badge ${esc(status)}">${esc(labels[status]||status)}</span>`;}
async function summary() { try { const {data}=await api('/summary'); for(const key of ['contractors','pending','accounts','projects']) $(`#stat-${key}`).textContent=data[key]; $('#nav-contractors').textContent=data.contractors;$('#nav-projects').textContent=data.projects; } catch { for(const key of ['contractors','pending','accounts','projects']) $(`#stat-${key}`).textContent='—'; } }
function columns() {
  return state.tab==='contractors' ? [ ['full_name','Наименование'],['inn','ИНН'],['kpp','КПП'],['status','Статус'],['legal_address','Юридический адрес'],['created_at','Создано'],['updated_at','Обновлено'] ]
    : [['id','ID'],['name','Название'],['address','Адрес'],['city','Город'],['customer','Заказчик'],['intermediary','Посредник'],['contractor','Подрядчик'],['start_date','Начало'],['end_date','Окончание']];
}
function renderHead(){
  const sortable=state.tab==='contractors'?['full_name','inn','status','created_at','updated_at']:['name','city','start_date','end_date'];
  const tr=element('tr');
  for(const [key,label] of columns()){
    const th=element('th');th.scope='col';
    if(sortable.includes(key)){
      th.setAttribute('aria-sort',state.sort===key?(state.order==='asc'?'ascending':'descending'):'none');
      const b=button(`${label}${state.sort===key?(state.order==='asc'?' ↑':' ↓'):''}`,'',()=>{state.order=state.sort===key&&state.order==='asc'?'desc':'asc';state.sort=key;state.page=1;load();});
      b.className='';th.append(b);
    }else th.textContent=label;
    tr.append(th);
  }
  $('#table-head').replaceChildren(tr);
}
function renderRows(){
  $('#table-body').replaceChildren();
  for(const row of state.rows){
    const tr=element('tr',state.selected?.id===row.id?'selected':'');tr.tabIndex=0;tr.setAttribute('aria-selected',String(state.selected?.id===row.id));
    for(const [key] of columns()){
      const td=element('td');let value=row[key];
      if(key==='status')td.innerHTML=badge(value);
      else {
        if(['customer','intermediary','contractor'].includes(key)) value=value?.full_name;
        if(['created_at','updated_at','start_date','end_date'].includes(key))value=date(value);
        td.textContent=value||'—';td.title=value||'—';
      }
      tr.append(td);
    }
    const select=()=>{state.selected=row;renderRows();renderActions();};
    tr.addEventListener('click',select);tr.addEventListener('dblclick',()=>openRecord(row.id));
    tr.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();select();openRecord(row.id);}else if(e.key===' '){e.preventDefault();select();}});
    $('#table-body').append(tr);
  }
}
function renderActions(){
  const row=state.selected;$('#action-buttons').replaceChildren();$('#selection-label').textContent=row?`Выбрано: ${row.full_name||row.name}`:'Выберите строку для работы с записью';
  const edit=button('Редактировать','secondary',()=>openRecord(row.id));edit.disabled=!row||state.loading;$('#action-buttons').append(edit);
  if(state.tab!=='contractors')return;
  const names={ACTIVE:'Утвердить',REJECTED:'Отклонить',ARCHIVED:'В архив',PENDING_REVIEW:'На проверку'};
  for(const target of ['ACTIVE','REJECTED','PENDING_REVIEW','ARCHIVED']){
    const b=button(names[target],target==='ACTIVE'?'approve':target==='REJECTED'?'danger':'secondary',async()=>{
      if(!row)return;const relevant=Array.from($('#action-buttons').querySelectorAll('button'));relevant.forEach(n=>n.disabled=true);
      try{await send(`/contractors/${row.id}/status`,'PATCH',{status:target});toast('Статус обновлён');await load();summary();}catch(e){toast(e.message,true);renderActions();}
    });b.disabled=!row||state.loading||!transitions[row.status]?.includes(target);$('#action-buttons').append(b);
  }
}
let searchTimer;
async function load(){
  state.controller?.abort();const controller=new AbortController();state.controller=controller;const request=++state.request;
  state.loading=true;state.selected=null;state.rows=[];renderHead();renderRows();renderActions();
  $('#registry-table').setAttribute('aria-busy','true');$('#previous-page').disabled=true;$('#next-page').disabled=true;
  const message=$('#list-message');message.hidden=false;message.innerHTML='<span class="spinner" aria-hidden="true"></span>Загружаем записи…';
  const q=new URLSearchParams({page:String(state.page),limit:String(state.limit),sort_by:state.sort,sort_order:state.order});
  if(state.search)q.set('search',state.search);
  if(state.tab==='contractors'&&state.status)q.set('status',state.status);
  if(state.tab==='projects'){if(state.city)q.set('city',state.city);for(const [key,value]of Object.entries(state.participants))if(value)q.set(key,value);}
  try{
    const result=await api(`/${state.tab}?${q}`,{signal:controller.signal});if(request!==state.request)return;
    if(!result.data.length&&state.page>1&&result.pagination.total_pages<state.page){state.page=Math.max(1,result.pagination.total_pages);return load();}
    state.rows=result.data;state.total=result.pagination.total;renderRows();
    message.hidden=state.rows.length>0;message.textContent='Записей не найдено. Измените фильтры или добавьте новую запись.';
    $('#result-count').textContent=`Найдено: ${state.total}`;
    $('#page-range').textContent=state.total?`${(state.page-1)*state.limit+1}–${Math.min(state.page*state.limit,state.total)} из ${state.total}`:'Нет записей';
    $('#page-label').textContent=`${state.page} / ${Math.max(1,result.pagination.total_pages)}`;
    $('#previous-page').disabled=state.page<=1;$('#next-page').disabled=state.page>=result.pagination.total_pages;
  }catch(e){if(e.name==='AbortError'||request!==state.request)return;message.hidden=false;message.replaceChildren(element('p','',e.message),button('Повторить','secondary',load));$('#result-count').textContent='Ошибка загрузки';$('#page-range').textContent='';$('#page-label').textContent='—';}
  finally{if(request===state.request){state.loading=false;$('#registry-table').setAttribute('aria-busy','false');renderActions();}}
}
function changeTab(tab){
  if(state.tab===tab)return;clearTimeout(searchTimer);state.tab=tab;state.page=1;state.sort='created_at';state.order='desc';state.search='';state.city='';state.participants={};
  $('#search').value='';$('#city-filter').value='';const isContractor=tab==='contractors';
  for(const n of document.querySelectorAll('[data-tab]')){n.classList.toggle('active',n.dataset.tab===tab);n.setAttribute('aria-current',n.dataset.tab===tab?'page':'false');}
  $('#page-title').textContent=$('#breadcrumb').textContent=isContractor?'Контрагенты':'Проекты';
  $('#page-description').textContent=isContractor?'Реквизиты организаций, банковские счета и статусы проверки.':'Строительные объекты, участники и технико-экономические показатели.';
  $('#create-button').textContent=isContractor?'＋ Добавить контрагента':'＋ Добавить проект';$('#registry-title').textContent=isContractor?'Реестр контрагентов':'Реестр проектов';
  $('#search').placeholder=isContractor?'Наименование или ИНН':'Название, адрес или город';$('#search').setAttribute('aria-label',$('#search').placeholder);
  $('#status-filter-label').hidden=!isContractor;$('#city-filter-label').hidden=isContractor;$('#project-filters').hidden=isContractor;
  if(!isContractor)projectFilters();load();
}
function projectFilters(){
  const container=$('#project-filters');container.replaceChildren();
  for(const [key,title]of [['customer_id','Заказчик'],['intermediary_id','Посредник'],['contractor_id','Подрядчик']]){
    const lookup=participantLookup(key,title,null,()=>{state.participants[key]=lookup.value();state.page=1;load();});container.append(lookup.node);
  }
}
function field(key,title,value='',options={}){
  const wrap=element('label',`field${options.full?' full':''}`);wrap.dataset.field=key;wrap.append(element('span','',title));
  const input=element(options.tag||'input');input.name=key;
  if(options.tag!=='textarea')input.type=options.type||'text';input.value=value??'';
  for(const prop of ['required','readOnly','maxLength','minLength','pattern','step','min','placeholder'])if(options[prop]!==undefined)input[prop]=options[prop];
  if(['inn','kpp','bik','account_number','correspondent_account'].includes(key.split('.').at(-1)))input.inputMode='numeric';
  const error=element('span','field-error');error.id=`error-${key.replace(/[^a-zA-Z0-9]/g,'-')}`;input.setAttribute('aria-describedby',error.id);wrap.append(input,error);
  return {node:wrap,input,error};
}
function selectField(key,title,value,choices){
  const f=field(key,title);const select=element('select');select.name=key;
  for(const [val,text]of choices){const option=element('option','',text);option.value=val;select.append(option);}select.value=value;f.input.replaceWith(select);f.input=select;return f;
}
function errors(form,e){
  for(const n of form.querySelectorAll('.field-error'))n.textContent='';for(const n of form.querySelectorAll('[aria-invalid]'))n.removeAttribute('aria-invalid');form.querySelector('.form-alert')?.remove();
  const alert=element('div','form-alert',e.message);alert.setAttribute('role','alert');form.prepend(alert);
  for(const [key,message]of Object.entries(e.fields||{})){
    const fields=Array.from(form.querySelectorAll('[data-field]'));
    const wrap=fields.find(n=>n.dataset.field===key)||fields.find(n=>key.startsWith(`${n.dataset.field}.`));
    if(wrap){const target=wrap.querySelector('.field-error');if(target)target.textContent=message;wrap.querySelector('input,textarea,select')?.setAttribute('aria-invalid','true');}
  }
  form.querySelector('[aria-invalid=true]')?.focus();
}
async function saving(form,action){
  if(form.dataset.saving)return;form.dataset.saving='true';const controls=Array.from(form.querySelectorAll('button'));const old=controls.map(b=>b.disabled);controls.forEach(b=>b.disabled=true);
  const submit=form.querySelector('[type=submit]');const previous=submit?.textContent;if(submit)submit.textContent='Сохраняем…';
  try{await action();}catch(e){errors(form,e);}finally{delete form.dataset.saving;controls.forEach((b,i)=>b.disabled=old[i]);if(submit)submit.textContent=previous;}
}
function modal(title,eyebrow){
  $('#dialog-title').textContent=title;$('#dialog-eyebrow').textContent=eyebrow;$('#dialog-body').replaceChildren();if(!$('#editor').open)$('#editor').showModal();
}
function cancelButton(){return button('Отмена','secondary',()=>$('#editor').close());}
function formActions(form,label='Сохранить'){
  const row=element('div','dialog-actions');const save=button(label,'primary');save.type='submit';row.append(cancelButton(),save);form.append(row);
}
function accountInputs(account={},prefix=''){
  const grid=element('div','form-grid'), map={};
  for(const [key,title,max]of [['bank_name','Наименование банка',255],['bik','БИК',9],['account_number','Номер счёта',20],['correspondent_account','Корреспондентский счёт',20]]){
    const f=field(prefix+key,title,account[key]||'',{maxLength:max,required:key!=='correspondent_account'});map[key]=f.input;grid.append(f.node);
  }
  const currency=selectField(prefix+'currency','Валюта',account.currency||'RUB',[['RUB','RUB — российский рубль'],['USD','USD — доллар США'],['EUR','EUR — евро'],['CNY','CNY — юань']]);map.currency=currency.input;grid.append(currency.node);
  return {node:grid,value:()=>Object.fromEntries(Object.entries(map).map(([k,n])=>[k,n.value]))};
}
async function openRecord(id){
  modal('Загружаем карточку…','МАСТЕР-ДАННЫЕ');$('#dialog-body').innerHTML='<p><span class="spinner"></span>Загрузка…</p>';
  const tab=state.tab;
  try{const {data}=await api(`/${tab}/${id}`);if(!$('#editor').open)return;if(tab==='contractors')contractorEditor(data);else projectEditor(data);}
  catch(e){$('#dialog-body').replaceChildren(element('p','form-alert',e.message),button('Повторить','secondary',()=>openRecord(id)));}
}
function contractorEditor(data){
  const editing=!!data;modal(editing?'Карточка контрагента':'Новый контрагент','КОНТРАГЕНТЫ');
  const body=$('#dialog-body'),form=element('form');form.noValidate=true;
  if(editing){const status=element('div','section-heading');status.innerHTML=badge(data.status);body.append(status);}
  const grid=element('div','form-grid');const full=field('full_name','Наименование *',data?.full_name,{required:true,maxLength:255,full:true});
  const inn=field('inn','ИНН *',data?.inn,{required:true,readOnly:editing,maxLength:12});const kpp=field('kpp','КПП',data?.kpp,{maxLength:9});
  const address=field('legal_address','Юридический адрес',data?.legal_address,{tag:'textarea',full:true,maxLength:5000});grid.append(full.node,inn.node,kpp.node,address.node);form.append(grid);body.append(form);
  const enrichment=!editing?innEnrichment(form,{full,inn,kpp,address}):null;
  let accountValues;
  if(!editing){
    const section=element('section','form-section');section.dataset.field='bank_accounts';const heading=element('div','section-heading');heading.append(element('h3','','Банковские счета *'));section.append(heading,element('span','field-error'));
    const cards=element('div');section.append(cards);const records=[];
    const render=()=>{
      const snapshots=records.map(r=>({...r.inputs.value(),is_primary:r.radio.checked}));cards.replaceChildren();records.length=0;
      snapshots.forEach((v,i)=>add(v,i));
    };
    function add(v={},index=records.length){
      const card=element('div','account-card'),top=element('div','account-heading'),label=element('label');const radio=element('input');radio.type='radio';radio.name='primary_account';radio.checked=v.is_primary??records.length===0;label.append(radio,document.createTextNode('Основной счёт'));top.append(label);
      const inputs=accountInputs(v,`bank_accounts.${index}.`);const record={inputs,radio};
      const remove=button('Удалить','ghost small',()=>{if(records.length===1){toast('Нужен хотя бы один банковский счёт',true);return;}const pos=records.indexOf(record);records.splice(pos,1);if(radio.checked)records[0].radio.checked=true;render();});top.append(remove);card.append(top,inputs.node);cards.append(card);records.push(record);
    }
    heading.append(button('＋ Добавить счёт','secondary small',()=>add()));add();accountValues=()=>records.map(r=>({...r.inputs.value(),is_primary:r.radio.checked}));form.append(section);
  }
  formActions(form,editing?'Сохранить реквизиты':'Создать контрагента');
  form.addEventListener('submit',e=>{e.preventDefault();saving(form,async()=>{
    const value={full_name:full.input.value,kpp:kpp.input.value||null,legal_address:address.input.value||null};
    if(!editing){value.inn=inn.input.value;value.bank_accounts=accountValues();}
    if(enrichment?.lookupId())value.lookup_id=enrichment.lookupId();
    await send(editing?`/contractors/${data.id}`:'/contractors',editing?'PATCH':'POST',value);$('#editor').close();toast(editing?'Реквизиты сохранены':'Контрагент создан и отправлен на проверку');await load();summary();
  });});
  if(editing){
    if(data.registry_snapshot)body.append(registryDetails(data.registry_snapshot,data));
    const section=element('section','form-section'),heading=element('div','section-heading'),title=element('div');title.append(element('h3','','Банковские счета'),element('p','','Изменения счетов сохраняются отдельно.'));heading.append(title,button('＋ Добавить счёт','secondary small',()=>accountInline(section,data)));section.append(heading);
    for(const account of data.bank_accounts){
      const card=element('div','account-card'),info=element('div','account-summary'),details=element('div');details.append(element('strong','',account.bank_name),element('p','',`${account.account_number} · ${account.currency}`),element('p','',`БИК ${account.bik}${account.correspondent_account?` · К/с ${account.correspondent_account}`:''}`));
      const actions=element('div','account-actions');if(account.is_primary)details.append(element('span','badge ACTIVE','Основной'));
      else actions.append(button('Сделать основным','secondary small',()=>accountOperation(actions,async()=>{await send(`/contractors/${data.id}/bank-accounts/${account.id}/primary`,'PATCH',{});await reloadContractor(data.id);toast('Основной счёт изменён');})));
      actions.append(button('Изменить','secondary small',()=>accountInline(section,data,account)),button('Удалить','danger small',()=>deleteAccountInline(section,data,account)));
      info.append(details,actions);card.append(info);section.append(card);
    }
    body.append(section);const metadata=element('p','metadata',`ID: ${data.id} · Создано: ${date(data.created_at)} · Обновлено: ${date(data.updated_at)}`);body.append(metadata);
  }
}
function registryDetails(snapshot,current){
  const section=element('section','registry-details');const heading=element('div','section-heading');heading.append(element('h3','','Сведения из реестра'));section.append(heading);
  const registryStatus={ACTIVE:'Действующая',LIQUIDATING:'В процессе ликвидации',LIQUIDATED:'Ликвидирована',BANKRUPT:'Банкротство',REORGANIZING:'Реорганизация'};
  const list=element('dl','registry-facts');
  const sourceNames={dadata:'DaData',kontur_focus:'Контур.Фокус',seldon_basis:'Seldon.Basis'};
  const items=[['Источник',`${sourceNames[snapshot.provider]||'Сервис реквизитов'} · ЕГРЮЛ / ЕГРИП`],['Получено',snapshot.fetched_at?new Date(snapshot.fetched_at).toLocaleString('ru-RU'):'—'],['Актуальность реестра',date(snapshot.actuality_date)],['Тип',snapshot.company_type==='INDIVIDUAL'?'Индивидуальный предприниматель':'Юридическое лицо'],['Полное наименование',snapshot.full_legal_name],['Краткое наименование',snapshot.short_name],['ИНН',snapshot.inn],['ОГРН / ОГРНИП',snapshot.ogrn],['ОКПО',snapshot.okpo],['Основной ОКВЭД',snapshot.okved],['Статус в реестре',registryStatus[snapshot.registry_status]||snapshot.registry_status||'Не получен'],['Дата регистрации',date(snapshot.registration_date)],['Руководитель',snapshot.management?.name],['Должность',snapshot.management?.post]];
  for(const [label,value]of items){const entry=element('div');entry.append(element('dt','',label),element('dd','',value||'Не получено'));list.append(entry);}section.append(list);
  const suggested=snapshot.suggested_fields;
  if(current&&suggested&&['full_name','kpp','legal_address'].some(k=>(current[k]??null)!==(suggested[k]??null)))section.append(element('p','lookup-note','Реквизиты карточки отличаются от исходного результата поиска: часть значений введена или изменена вручную.'));
  return section;
}
function innEnrichment(form,fields){
  const section=element('section','inn-enrichment'),heading=element('div','section-heading'),title=element('div');
  title.append(element('h3','','Заполнить по ИНН'),element('p','','Введите ИНН в поле ниже и получите реквизиты из реестра.'));
  const search=button('Найти по ИНН','secondary');search.disabled=true;heading.append(title,search);const note=element('p','lookup-note','Проверяем доступность поиска…'),result=element('div');section.append(heading,note,result);form.prepend(section);
  let selected=null,request=0,controller;
  const inputSnapshot=()=>Object.fromEntries(['full_name','kpp','legal_address'].map(k=>[k,fields[{full_name:'full',kpp:'kpp',legal_address:'address'}[k]].input]));
  fields.inn.input.addEventListener('input',()=>{selected=null;request++;controller?.abort();result.replaceChildren();search.disabled=section.dataset.enabled!=='true';search.textContent='Найти по ИНН';});
  api('/integrations/inn/status').then(({data})=>{
    if(!section.isConnected)return;section.dataset.enabled=String(data.enabled);search.disabled=!data.enabled;
    note.textContent=data.enabled?`Источник — ${data.display_name||'сервис реквизитов'}. Сначала вы увидите найденные сведения, затем сможете заполнить форму.`:'Поиск по ИНН пока не подключён. Все реквизиты можно заполнить вручную.';
  }).catch(()=>{note.textContent='Не удалось проверить доступность поиска. Можно продолжить ручной ввод.';});
  search.addEventListener('click',async()=>{
    const inn=fields.inn.input.value.trim();
    if(!/^(\d{10}|\d{12})$/.test(inn)){fields.inn.error.textContent='Введите ИНН из 10 или 12 цифр';fields.inn.input.focus();return;}
    const version=++request;controller?.abort();controller=new AbortController();selected=null;search.disabled=true;search.textContent='Ищем…';result.replaceChildren();fields.inn.error.textContent='';
    try{
      const {data}=await api('/contractors/lookup-by-inn',{method:'POST',body:JSON.stringify({inn}),signal:controller.signal});
      if(version!==request||!section.isConnected||fields.inn.input.value.trim()!==inn)return;
      const preview=element('div','lookup-preview');preview.append(registryDetails({...data.registry,provider:data.provider,fetched_at:data.fetched_at}));
      const proposed=element('dl','registry-facts');for(const [key,label]of [['full_name','Будет заполнено: наименование'],['kpp','КПП'],['legal_address','Адрес']]){const row=element('div');row.append(element('dt','',label),element('dd','',data.fields[key]||'Не получено'));proposed.append(row);}preview.append(proposed);
      for(const warning of data.warnings)preview.append(element('p','lookup-warning',warning));
      if(data.cached)preview.append(element('p','lookup-note','Результат получен из сохранённого ответа за последние 24 часа.'));
      const confirm=element('label','lookup-confirm'),checkbox=element('input');checkbox.type='checkbox';confirm.append(checkbox,document.createTextNode('Заменить уже введённые наименование, КПП и адрес'));
      const hasChanges=()=>Object.entries(inputSnapshot()).some(([key,input])=>input.value.trim()&&(data.fields[key]??'')!==input.value.trim());
      confirm.hidden=!hasChanges();preview.append(confirm);
      const apply=button('Заполнить реквизиты','primary',()=>{
        if(fields.inn.input.value.trim()!==data.fields.inn)return;
        if(hasChanges()&&!checkbox.checked){confirm.hidden=false;checkbox.focus();toast('Подтвердите замену уже введённых реквизитов',true);return;}
        fields.inn.input.value=data.fields.inn;
        for(const [key,input]of Object.entries(inputSnapshot()))if(data.fields[key]!==null||key==='kpp')input.value=data.fields[key]??'';
        selected=data;preview.replaceChildren(element('p','lookup-success','Реквизиты заполнены. Проверьте их, добавьте банковский счёт и сохраните контрагента.'),button('Продолжить без сведений реестра','ghost small',()=>{selected=null;preview.replaceChildren(element('p','lookup-note','При сохранении источник реестра не будет привязан. Введённые реквизиты оставлены для ручной проверки.'));}));
      });preview.append(apply);result.append(preview);
    }catch(e){if(e.name!=='AbortError'&&version===request){result.replaceChildren(element('p','form-alert',e.message));if(e.fields?.inn)fields.inn.error.textContent=e.fields.inn;}}
    finally{if(version===request){search.disabled=false;search.textContent='Найти по ИНН';}}
  });
  return {lookupId:()=>selected&&selected.fields.inn===fields.inn.input.value.trim()?selected.lookup_id:null};
}
async function accountOperation(container,action){const controls=Array.from(container.querySelectorAll('button'));controls.forEach(n=>n.disabled=true);try{await action();summary();}catch(e){toast(e.message,true);}finally{controls.forEach(n=>n.disabled=false);}}
async function reloadContractor(id){const {data}=await api(`/contractors/${id}`);if($('#editor').open)contractorEditor(data);}
function accountInline(section,contractor,account){
  section.querySelector('.inline-account-form')?.remove();const form=element('form','account-card inline-account-form');form.noValidate=true;form.append(element('h3','section-heading',account?'Изменить счёт':'Новый счёт'));
  const inputs=accountInputs(account);form.append(inputs.node);const actions=element('div','dialog-actions'),save=button('Сохранить счёт','primary');save.type='submit';actions.append(button('Отмена','secondary',()=>form.remove()),save);form.append(actions);section.append(form);form.scrollIntoView({block:'nearest',behavior:'smooth'});
  form.addEventListener('submit',e=>{e.preventDefault();saving(form,async()=>{await send(`/contractors/${contractor.id}/bank-accounts${account?`/${account.id}`:''}`,account?'PATCH':'POST',inputs.value());await reloadContractor(contractor.id);toast('Банковский счёт сохранён');summary();});});
}
function deleteAccountInline(section,contractor,account){
  section.querySelector('.inline-account-form')?.remove();
  if(contractor.bank_accounts.length===1){toast('Нельзя удалить последний банковский счёт',true);return;}
  const form=element('form','account-card inline-account-form');form.append(element('p','',`Удалить счёт ${account.account_number}?`));let replacement;
  if(account.is_primary){replacement=selectField('replacement_primary_id','Назначить другим основным счётом',contractor.bank_accounts.find(a=>a.id!==account.id).id,contractor.bank_accounts.filter(a=>a.id!==account.id).map(a=>[a.id,`${a.bank_name} · ${a.account_number}`]));form.append(replacement.node);}
  const actions=element('div','dialog-actions'),remove=button('Удалить счёт','danger');remove.type='submit';actions.append(button('Отмена','secondary',()=>form.remove()),remove);form.append(actions);section.append(form);form.scrollIntoView({block:'nearest'});
  form.addEventListener('submit',e=>{e.preventDefault();saving(form,async()=>{await send(`/contractors/${contractor.id}/bank-accounts/${account.id}${replacement?`?replacement_primary_id=${encodeURIComponent(replacement.input.value)}`:''}`,'DELETE');await reloadContractor(contractor.id);toast('Счёт удалён');summary();});});
}
let lookupSerial=0;
function participantLookup(key,title,existing,onchange){
  const node=element('div','field lookup');node.dataset.field=key;const unique=`lookup-${++lookupSerial}`;const label=element('label','',title);label.htmlFor=unique;node.append(label);
  const controls=element('div','lookup-controls'),input=element('input');input.id=unique;input.type='search';input.placeholder='Найти активного контрагента';input.autocomplete='off';input.value=existing?.full_name||'';input.setAttribute('aria-label',title);input.setAttribute('aria-expanded','false');
  const results=element('div','lookup-results');results.hidden=true;results.id=`${unique}-results`;input.setAttribute('aria-controls',results.id);
  let chosen=existing?.id||null,query='',page=1,version=0,timer,controller;
  const clear=button('×','secondary small',()=>{chosen=null;input.value='';hide();onchange?.();input.focus();});clear.setAttribute('aria-label',`Очистить: ${title}`);controls.append(input,clear);node.append(controls,element('span','field-error'),results);
  function hide(){results.hidden=true;input.setAttribute('aria-expanded','false');}
  async function search(){
    const current=++version;controller?.abort();controller=new AbortController();results.hidden=false;input.setAttribute('aria-expanded','true');results.replaceChildren(element('p','','Поиск…'));
    try{
      const r=await api(`/contractors?status=ACTIVE&limit=10&page=${page}&sort_by=full_name&sort_order=asc&search=${encodeURIComponent(query)}`,{signal:controller.signal});if(current!==version||!node.isConnected)return;
      results.replaceChildren();for(const person of r.data){const b=button(person.full_name,'',()=>{chosen=person.id;input.value=person.full_name;hide();onchange?.();});b.className='';b.append(element('small','',`ИНН ${person.inn}`));results.append(b);}
      if(!r.data.length)results.append(element('p','','Активные контрагенты не найдены'));
      if(r.pagination.total_pages>1){const footer=element('div','lookup-footer');const prev=button('←','',()=>{page--;search();}),next=button('→','',()=>{page++;search();});prev.disabled=page===1;next.disabled=page>=r.pagination.total_pages;footer.append(prev,element('span','',`${page} / ${r.pagination.total_pages}`),next);results.append(footer);}
    }catch(e){if(e.name!=='AbortError'&&current===version)results.replaceChildren(element('p','',e.message));}
  }
  input.addEventListener('input',()=>{const had=chosen;chosen=null;query=input.value.trim();page=1;version++;controller?.abort();hide();clearTimeout(timer);timer=setTimeout(search,300);if(had)onchange?.();});
  input.addEventListener('focus',()=>{query=chosen?'':input.value.trim();page=1;search();});
  input.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();hide();}if(e.key==='Enter'&&!results.hidden)e.preventDefault();});
  node.addEventListener('focusout',()=>setTimeout(()=>{if(!node.contains(document.activeElement))hide();},120));
  return {node,value:()=>chosen};
}
function projectEditor(data){
  const editing=!!data;modal(editing?'Карточка проекта':'Новый строительный проект','ПРОЕКТЫ');const form=element('form');form.noValidate=true;const grid=element('div','form-grid'),map={};
  for(const [key,title,options]of [['name','Название проекта *',{full:true,maxLength:255}],['address','Адрес объекта *',{full:true,maxLength:5000}],['city','Город *',{maxLength:120}],['start_date','Начало строительства *',{type:'date'}],['end_date','Окончание строительства *',{type:'date'}]]){const f=field(key,title,data?.[key],{...options,required:true});map[key]=f.input;grid.append(f.node);}
  const participants={};for(const [key,title,person]of [['customer_id','Заказчик *',data?.customer],['intermediary_id','Посредник',data?.intermediary],['contractor_id','Подрядчик *',data?.contractor]]){const lookup=participantLookup(key,title,person);participants[key]=lookup;grid.append(lookup.node);}form.append(grid);
  const section=element('section','form-section');section.dataset.field='tep';const heading=element('div','section-heading');heading.append(element('h3','','Технико-экономические показатели'));const rows=element('div');section.append(heading,element('span','field-error'),rows);const tep=[];
  const redraw=()=>{const values=tep.map(r=>({name:r.name.value,value:r.value.value,unit:r.unit.value}));tep.length=0;rows.replaceChildren();values.forEach(add);};
  function add(value={}){const index=tep.length,row=element('div','tep-row'),record={};for(const [key,title,options]of [['name','Показатель',{maxLength:255}],['value','Значение',{type:'number',min:0,step:'any'}],['unit','Единица',{maxLength:60}]]){const f=field(`tep.${index}.${key}`,title,value[key],options);record[key]=f.input;row.append(f.node);}const remove=button('×','secondary small',()=>{tep.splice(tep.indexOf(record),1);redraw();});remove.setAttribute('aria-label','Удалить показатель');row.append(remove);tep.push(record);rows.append(row);}
  heading.append(button('＋ Добавить показатель','secondary small',()=>add()));(data?.tep||[]).forEach(add);form.append(section);formActions(form,editing?'Сохранить проект':'Создать проект');$('#dialog-body').append(form);
  if(editing)form.append(element('p','metadata',`ID: ${data.id} · Создано: ${date(data.created_at)} · Обновлено: ${date(data.updated_at)}`));
  form.addEventListener('submit',e=>{e.preventDefault();saving(form,async()=>{
    const value=Object.fromEntries(Object.entries(map).map(([k,n])=>[k,n.value]));for(const [k,lookup]of Object.entries(participants))value[k]=lookup.value();
    value.tep=tep.map(r=>({name:r.name.value,value:r.value.value.trim()===''?null:Number(r.value.value),unit:r.unit.value}));
    await send(editing?`/projects/${data.id}`:'/projects',editing?'PATCH':'POST',value);$('#editor').close();toast(editing?'Проект сохранён':'Проект создан');await load();summary();
  });});
}
for(const n of document.querySelectorAll('[data-tab]'))n.addEventListener('click',()=>changeTab(n.dataset.tab));
$('#search').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.search=e.target.value.trim();state.page=1;load();},300);});
$('#city-filter').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.city=e.target.value.trim();state.page=1;load();},300);});
$('#status-filter').addEventListener('change',e=>{state.status=e.target.value;state.page=1;load();});
$('#reset-filters').addEventListener('click',()=>{clearTimeout(searchTimer);state.page=1;state.search='';state.city='';state.participants={};state.status='PENDING_REVIEW';$('#search').value='';$('#city-filter').value='';$('#status-filter').value='PENDING_REVIEW';if(state.tab==='projects')projectFilters();load();});
$('#refresh-button').addEventListener('click',()=>{load();summary();});
$('#previous-page').addEventListener('click',()=>{if(state.page>1){state.page--;load();}});$('#next-page').addEventListener('click',()=>{state.page++;load();});
$('#create-button').addEventListener('click',()=>state.tab==='contractors'?contractorEditor():projectEditor());
$('#close-dialog').addEventListener('click',()=>$('#editor').close());
$('#editor').addEventListener('cancel',e=>{if($('#editor').querySelector('[data-saving=true]'))e.preventDefault();});
$('#status-filter').value=state.status;
summary();load();
