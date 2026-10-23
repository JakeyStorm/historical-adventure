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

function fourSceneFixture(fixture,selected='fable') {
  const {api,calls,service}=fixture;
  const script={...plan,scenes:Array.from({length:4},(_,i)=>({...plan.scenes[0],title:'Сцена '+i,narration:'Космический полёт.',visual:'Historical continuous Vostok shot, scene number '+i+'.'}))};
  api.check=async()=>({available:5000});
  api.request=async(path,body)=>{
    if(path==='v1/chat/completions'){calls.script++;return{choices:[{message:{content:JSON.stringify(script)}}],usage:{cost_rub:0.1}};}
    calls.voice++;assert.equal(body.voice,selected);return{audio:Buffer.alloc(500,1).toString('base64'),usage:{cost_rub:0.1}};
  };
  api.submit=async body=>{calls.video++;assert.equal(body.duration,'15');return{id:'scene-'+calls.video};};
  service.exportStory=async({directory,clips})=>{
    calls.export++;assert.deepEqual(clips,['clip-0.mp4','clip-1.mp4','clip-2.mp4','clip-3.mp4']);
    await writeFile(join(directory,'video-1.mp4'),'0000ftypmp42-result');await writeFile(join(directory,'poster-1.jpg'),'poster');
    return{output:'video-1.mp4',poster:'poster-1.jpg'};
  };
}

test('voice choices are exposed and invalid voices are rejected before any paid operation',async t=>{
  const {service,calls}=await fixture(t);
  assert.deepEqual(service.publicConfig().voices.map(voice=>voice.id),['gemini-charon','gemini-kore','onyx','nova','shimmer','echo','fable','alloy']);
  await assert.rejects(service.create({...input(),voice:'unknown'},'owner'),/голос/);
  assert.deepEqual(calls,{script:0,video:0,voice:0,export:0});
});

test('Gemini voice selection routes narration to the chosen model and preserves it after restart',async t=>{
  const f=await fixture(t);const original=f.api.request;
  f.api.request=async(path,body)=>{
    if(path!=='v1/audio/speech')return original(path,body);
    f.calls.voice++;assert.equal(body.model,'google/gemini-3.8-flash-tts');assert.equal(body.voice,'Kore');
    assert.equal(body.input,plan.scenes[0].narration);assert.equal(body.provider.allow_fallbacks,false);assert.equal('max_price' in body.provider,false);
    return{audio:Buffer.alloc(500,1).toString('base64'),contentType:'audio/wav',usage:{cost_rub:0.06}};
  };
  const request={...input(),voice:'gemini-kore'},accepted=await f.service.create(request,'owner');
  const result=await finished(f.service,accepted.id);assert.equal(result.status,'completed',result.error);assert.equal(result.voice,'gemini-kore');
  const journal=JSON.parse(await readFile(join(f.directory,'jobs',accepted.id+'.json'),'utf8'));assert.equal(journal.voiceModel,'google/gemini-3.8-flash-tts');
  f.service.close();const restored=new GenerationService(f.options);await restored.ready;t.after(()=>restored.close());
  assert.equal((await restored.create(request,'owner')).status,'completed');assert.equal(f.calls.voice,1);
});

test('four scenes run concurrently, retain their order and IDs, and use the selected voice once',async t=>{
  const f=await fixture(t,{budget:2000});fourSceneFixture(f);
  let active=0,peak=0;
  f.api.status=async()=>{
    assert.equal(f.calls.video,4,'all scenes must be submitted before waiting for a scene to finish');
    peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,20));active--;
    return{status:'completed',data:{video:{url:'https://example.com/scene.mp4'}},usage:{cost_rub:210}};
  };
  const request={...input(),duration:60,voice:'fable'},accepted=await f.service.create(request,'owner');
  const result=await finished(f.service,accepted.id);assert.equal(result.status,'completed',result.error);assert.equal(peak,4);assert.equal(result.voice,'fable');
  const journal=JSON.parse(await readFile(join(f.directory,'jobs',accepted.id+'.json'),'utf8'));
  assert.equal(new Set(journal.clips.map(clip=>clip.remoteId)).size,4);assert.ok(journal.clips.every(clip=>clip.completedAt&&clip.phase==='completed'));
  f.service.close();const restored=new GenerationService(f.options);await restored.ready;t.after(()=>restored.close());
  assert.equal((await restored.create(request,'owner')).status,'completed');
  assert.deepEqual(f.calls,{script:1,video:4,voice:1,export:1});
});

test('a lost parallel submission stops further paid requests and still collects accepted scenes',async t=>{
  const f=await fixture(t,{budget:2000});fourSceneFixture(f);
  f.api.submit=async()=>{f.calls.video++;if(f.calls.video===2)throw new Error('Acceptance response lost');return{id:'accepted-1'};};
  const accepted=await f.service.create({...input(),duration:60,voice:'fable'},'owner');
  assert.equal((await finished(f.service,accepted.id)).status,'needs_review');
  const journal=JSON.parse(await readFile(join(f.directory,'jobs',accepted.id+'.json'),'utf8'));
  assert.equal(journal.clips[0].phase,'completed');assert.equal(journal.clips[1].phase,'submitting');
  f.service.close();const restored=new GenerationService(f.options);await restored.ready;t.after(()=>restored.close());
  assert.equal(restored.get(accepted.id,'owner').status,'needs_review');
  assert.deepEqual(f.calls,{script:1,video:2,voice:0,export:0});
});

test('an explicit concurrency rejection reduces parallelism and safely retries only the rejected scene',async t=>{
  const f=await fixture(t,{budget:2000,pause:async()=>{}});fourSceneFixture(f);
  let collected=0;
  f.api.status=async()=>{collected++;return{status:'completed',data:{video:{url:'https://example.com/scene.mp4'}},usage:{cost_rub:210}};};
  f.api.submit=async()=>{
    const call=++f.calls.video;
    if(call===2){const error=new Error('Too many active scenes');error.status=429;error.definiteRejection=true;throw error;}
    if(call===3)assert.equal(collected,1,'wait for the accepted scene before retrying the rejected one');
    return{id:'accepted-'+call};
  };
  const accepted=await f.service.create({...input(),duration:60,voice:'fable'},'owner');
  assert.equal((await finished(f.service,accepted.id)).status,'completed');assert.equal(collected,4);
  assert.deepEqual(f.calls,{script:1,video:5,voice:1,export:1});
});
