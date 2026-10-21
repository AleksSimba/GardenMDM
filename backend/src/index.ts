import { app, setReady } from './app.js';
import { migrate, seed, pool } from './db.js';

async function main() {
  await migrate(); await seed(); setReady(true);
  const server=app.listen(3000,'0.0.0.0',()=>console.log('GardenMDM listening on :3000'));
  let stopping=false;
  const shutdown=()=>{
    if(stopping) return; stopping=true; setReady(false);
    const timer=setTimeout(()=>process.exit(1),10000); timer.unref();
    server.close(()=>{ pool.end().then(()=>process.exit(0)).catch(()=>process.exit(1)); });
  };
  process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
}
main().catch(err=>{ console.error('Startup failed:',err.message); pool.end().finally(()=>process.exit(1)); });
