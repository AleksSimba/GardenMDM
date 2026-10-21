// Isolated browser QA harness. Never starts against a production database.
import express from 'express';
import {app,setReady} from '../dist/app.js';
import {migrate,pool} from '../dist/db.js';
import {setRegistryProviderForTests} from '../dist/party-lookup.js';
import {normalizeDadata} from '../dist/party-provider.js';
if(process.env.NODE_ENV!=='test'||process.env.PGDATABASE!=='mdm_test')throw Error('Browser fixture requires NODE_ENV=test and mdm_test');
await migrate();
setRegistryProviderForTests({name:'dadata',enabled:true,async lookup(inn){
  return normalizeDadata({suggestions:[{data:{inn,type:inn.length===10?'LEGAL':'INDIVIDUAL',branch_type:'MAIN',kpp:inn.length===10?'990401001':null,
    name:{full_with_opf:'ТЕСТ: Общество с ограниченной ответственностью «Проверка заполнения»',short_with_opf:'ТЕСТ: ООО «Проверка заполнения»'},
    ogrn:'1029900000002',okpo:'87654321',okved:'41.20',address:{data:{source:'ТЕСТ: демонстрационный адрес из реестра'}},
    state:{status:'ACTIVE',registration_date:Date.UTC(2020,0,1),actuality_date:Date.UTC(2026,9,1)},management:{name:'ТЕСТ: Руководитель',post:'Директор'}}}]},inn);
}});
setReady(true);
const web=express();
web.use((req,res,next)=>req.path.startsWith('/api/')?app(req,res,next):next());
web.use(express.static('/preview'));
const server=web.listen(3000,'0.0.0.0',()=>console.log('TEST-ONLY browser preview on :3000; external provider is mocked'));
process.on('SIGTERM',()=>server.close(()=>pool.end().then(()=>process.exit(0))));
