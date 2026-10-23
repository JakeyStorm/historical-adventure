import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GenerationService} from '../generation.mjs';
import {createAppServer} from '../server.mjs';

const input=()=>({requestId:randomUUID(),prompt:'Первый полёт Гагарина в космос в 1961 году.',duration:3,count:1,sound:true,automatic:true,narration:true,publish:true});
const plan={title:'Первый полёт',description:'Короткий исторический рассказ.',era:'XX век',year:'1961',date:'12 апреля 1961 года',place:'Байконур',scenes:[{title:'Старт',visual:'A wide historical shot of the Vostok launch in 1961, slow cinematic camera.',narration:'Гагарин отправился в космос.'}],quiz:[]};
async function fixture(t,overrides={}) {
  const directory=await mkdtemp(join(tmpdir(),'historical-automatic-'));
  const calls={script:0,video:0,voice:0,export:0};
  const api={check:async()=>({available:1000}),
    request:async(path,body)=>{
      if(path==='v1/chat/completions'){calls.script++;return{choices:[{message:{content:JSON.stringify(plan)}}],usage:{cost_rub:0.1}};}
      assert.equal(path,'v1/audio/speech');calls.voice++;assert.equal(body.input,plan.scenes[0].narration);
      return{audio:Buffer.alloc(500,1).toString('base64'),usage:{cost_rub:0.1}};
    },
    submit:async body=>{calls.video++;assert.equal(body.duration,'3');assert.ok(body.prompt.includes('Vostok'));return{id:'remote-'+calls.video};},
    status:async()=>({status:'completed',data:{video:{url:'https://example.com/test.mp4'}},usage:{cost_rub:42}})};
  const options={key:'pza_test',password:'owner',directory,budget:100,api,verifyMedia:async()=>{},sources:async()=>[{title:'Гагарин',url:'https://ru.wikipedia.org/wiki/Гагарин',text:'Справочный факт.'}],
    download:async(_,file)=>writeFile(file,'0000ftypmp42-test'),
    exportStory:async({directory,index,voice})=>{calls.export++;assert.equal((await readFile(voice)).length,500);const output=`video-${index+1}.mp4`,poster=`poster-${index+1}.jpg`;await writeFile(join(directory,output),'0000ftypmp42-result');await writeFile(join(directory,poster),'poster');return{output,poster};},...overrides};
  const service=new GenerationService(options);await service.ready;
  t.after(async()=>{service.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.match(basename(directory),/^historical-automatic-/);await rm(directory,{recursive:true,force:true});});
  return{service,api,calls,options,directory};
}
async function finished(service,id) {
  for(let i=0;i<150;i++){const job=service.get(id,'owner');if(['completed','needs_review','failed'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}
  throw new Error('Automatic job did not finish');
}

test('automatic quote includes screenplay and one reusable narration for two videos',async t=>{
  const {service}=await fixture(t);
  assert.equal(service.estimate(input()).estimatedCost,49);
  assert.equal(service.estimate({...input(),count:2}).estimatedCost,94);
  assert.equal(service.estimate({...input(),narration:false}).estimatedCost,48);
});

test('one website submission writes the script, videos, voice, edit and public library automatically',async t=>{
  const {service,api,calls,options}=await fixture(t);
  const server=createAppServer(service);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=input();
  const submit=()=>fetch(base+'/api/generation/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Generation-Access':'owner'},body:JSON.stringify(request)});
  const [one,two]=await Promise.all([submit(),submit()]);assert.equal(one.status,202);assert.equal(two.status,202);
  const job=await one.json();assert.equal((await two.json()).id,job.id);
  const result=await finished(service,job.id);assert.equal(result.status,'completed',result.error);
  assert.equal(result.narration,true);assert.equal(result.plan.narration,plan.scenes[0].narration);
  assert.deepEqual(calls,{script:1,video:1,voice:1,export:1});
  assert.deepEqual([...new Set(result.timeline.map(step=>step.stage))],['planning','generating','narrating','assembling','publishing','completed']);
  const library=await(await fetch(base+'/api/library')).json();assert.equal(library.length,1);assert.equal(library[0].id,result.libraryIds[0]);
  assert.equal(library[0].automatic,true);assert.equal(library[0].narrated,true);
  assert.equal((await fetch(base+library[0].image)).status,200);
  const range=await fetch(base+library[0].video,{headers:{Range:'bytes=0-11'}});assert.equal(range.status,206);
  service.close();const restored=new GenerationService(options);await restored.ready;t.after(()=>restored.close());
  assert.equal((await restored.create(request,'owner')).id,job.id);assert.equal((await restored.library()).length,1);
  assert.deepEqual(calls,{script:1,video:1,voice:1,export:1});
});

test('a missing voice response never publishes a silent result or repeats a paid stage after restart',async t=>{
  const {service,api,calls,options}=await fixture(t);
  const original=api.request;
  api.request=async(path,body)=>{if(path==='v1/audio/speech'){calls.voice++;throw new Error('Paid voice response lost');}return original(path,body);};
  const request=input(),job=await service.create(request,'owner');
  assert.equal((await finished(service,job.id)).status,'needs_review');
  assert.equal(service.outputPath(job.id,'video-1.mp4'),null);assert.deepEqual(await service.library(),[]);
  service.close();const restored=new GenerationService(options);await restored.ready;t.after(()=>restored.close());
  assert.equal((await restored.create(request,'owner')).status,'needs_review');
  assert.equal(calls.script,1);assert.equal(calls.video,1);assert.equal(calls.voice,1);assert.equal(calls.export,0);
});

test('public generation needs no code, hides billing, isolates sessions and keeps limits after restart',async t=>{
  const {service,calls,options}=await fixture(t,{publicAccess:true,budget:200,publicMaxCost:50,publicJobsPerHour:1});
  const server=createAppServer(service);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const configResponse=await fetch(base+'/api/generation/config'),config=await configResponse.json();
  assert.equal(config.enabled,true);assert.equal(config.publicAccess,true);
  for(const field of ['requiresPassword','rate','audioRate','budgetRemaining','scriptReserveRub'])assert.equal(field in config,false);
  const cookie=configResponse.headers.get('set-cookie').split(';')[0];
  assert.match(configResponse.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  assert.equal((await fetch(base+'/api/generation/config',{headers:{'X-Generation-Access':'wrong'}})).status,401);
  const post=(request,extra={})=>fetch(base+'/api/generation/jobs',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...extra},body:JSON.stringify(request)});
  const request={...input(),automatic:false};
  const accepted=await post(request);assert.equal(accepted.status,202);const job=await accepted.json();
  assert.equal(job.automatic,true);assert.equal('estimatedCost' in job,false);assert.equal('actualCost' in job,false);
  assert.equal((await(await post(request)).json()).id,job.id);
  assert.equal((await finished(service,job.id)).status,'completed');
  assert.equal((await fetch(base+'/api/generation/jobs/'+job.id)).status,404);
  const own=await(await fetch(base+'/api/generation/jobs/'+job.id,{headers:{Cookie:cookie}})).json();
  assert.equal(own.status,'completed');assert.equal('actualCost' in own,false);
  assert.equal((await fetch(base+'/api/generation/check',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'})).status,401);
  assert.equal((await post({...input(),duration:15})).status,400);
  assert.equal((await post(input(),{'X-Forwarded-For':'203.0.113.1'})).status,429);
  assert.deepEqual(calls,{script:1,video:1,voice:1,export:1});
  service.close();const restored=new GenerationService(options);await restored.ready;t.after(()=>restored.close());
  const server2=createAppServer(restored);await new Promise(r=>server2.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server2.close(r)));
  const next=`http://127.0.0.1:${server2.address().port}`;
  assert.equal((await fetch(next+'/api/generation/jobs/'+job.id,{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(next+'/api/generation/jobs',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(input())})).status,429);
});

test('an exhausted public budget returns a visitor message without exposing billing or calling providers',async t=>{
  const {service,calls}=await fixture(t,{publicAccess:true,budget:0});
  const server=createAppServer(service);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await(await fetch(base+'/api/generation/config')).json()).enabled,false);
  const response=await fetch(base+'/api/generation/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input())});
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/Polza|баланс|лимит|₽/);
  assert.deepEqual(calls,{script:0,video:0,voice:0,export:0});
});

test('unlimited monetary settings allow long public jobs while still checking the real provider balance',async t=>{
  const {service,api,calls}=await fixture(t,{publicAccess:true,budget:'unlimited',publicMaxCost:'unlimited'});
  service.close(); // Validate acceptance without starting any renderer or provider worker.
  api.check=async()=>({available:2000});
  assert.equal(service.config().budgetRemaining,null);
  assert.equal(service.publicConfig().enabled,true);
  assert.equal(service.publicConfig().maxDurationByCount[2],60);
  const request={...input(),duration:60,count:2};
  const job=await service.create(request,'owner',{publicAccess:true,ownerHash:'test-session',clientHash:'test-client'});
  assert.equal(job.status,'queued');assert.ok(job.estimatedCost>500);
  const {service:empty,api:emptyApi,calls:emptyCalls}=await fixture(t,{publicAccess:true,budget:'unlimited',publicMaxCost:'unlimited'});
  empty.close();emptyApi.check=async()=>({available:0});
  await assert.rejects(empty.create(input(),'owner',{publicAccess:true,ownerHash:'test-session',clientHash:'test-client'}),/балансе/);
  assert.deepEqual(calls,{script:0,video:0,voice:0,export:0});
  assert.deepEqual(emptyCalls,{script:0,video:0,voice:0,export:0});
});
