import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GenerationService, PolzaClient } from '../generation.mjs';
import { createAppServer } from '../server.mjs';

const prompt = 'Исторический общий план старинного города и реки.';
const input = () => ({ requestId:randomUUID(), prompt, duration:5, count:1, sound:false });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'historical-polza-'));
  const api = { calls:0, async check() { return { valid:true, balance:80, available:80 }; },
    async submit() { this.calls++; return { id:'gen_example' }; },
    async status() { return { status:'completed', data:{ video:{url:'https://example.com/video.mp4'} }, usage:{cost_rub:50} }; } };
  const service = new GenerationService({ key:'pza_test_private', password:'owner', directory, api,
    download:async (_, path) => writeFile(path, Buffer.from('0000ftypmp42-test-video')), ...options });
  await service.ready;
  t.after(async () => { service.close(); assert.equal(dirname(resolve(directory)),resolve(tmpdir())); assert.match(basename(directory),/^historical-polza-/); await rm(directory, {recursive:true,force:true}); });
  return { service, api, directory };
}
async function finished(service, id) {
  for (let i = 0; i < 100; i++) { const job = service.get(id, 'owner'); if (['completed','failed','needs_review'].includes(job.status)) return job; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Job did not finish');
}

test('provider request caps the price and sends documented Kling parameters', async () => {
  let sent;
  const client = new PolzaClient('pza_test_private', async (url, options) => { sent = {url,...options}; return new Response(JSON.stringify({id:'gen_test'}),{status:200}); });
  await client.submit({prompt,duration:'5',mode:'std',sound:false,aspect_ratio:'16:9',images:[]}, 10);
  const body = JSON.parse(sent.body);
  assert.equal(sent.url, 'https://polza.ai/api/v1/media');
  assert.equal(body.model, 'kling/v3'); assert.equal(body.async, true); assert.equal(body.input.sound, false);
  assert.equal(body.provider.max_price.video_per_second, 10); assert.equal(body.provider.allow_fallbacks, false);
});

test('repeated concurrent clicks cause one submission and budget survives restart', async t => {
  const {service, api, directory} = await fixture(t);
  const request = input();
  const [one,two] = await Promise.all([service.create(request,'owner'), service.create(request,'owner')]);
  assert.equal(one.id,two.id);
  assert.equal((await finished(service,one.id)).status,'completed'); assert.equal(api.calls,1);
  assert.equal(service.config().budgetRemaining,0);
  await assert.rejects(service.create(input(),'owner'), /лимита/);
  await assert.rejects(service.create({...request,prompt:prompt+' Другое описание.'},'owner'), /другими параметрами/);
  service.close();
  const restored = new GenerationService({key:'pza_test_private',password:'owner',directory,api});
  await restored.ready; t.after(() => restored.close());
  assert.equal(restored.config().budgetRemaining,0);
  assert.equal((await restored.create(request,'owner')).id,one.id); assert.equal(api.calls,1);
});

test('a lost submission response is never retried or released as unspent', async t => {
  const {service,api} = await fixture(t);
  api.submit = async () => { api.calls++; throw new Error('Connection lost after acceptance'); };
  const request = input(), job = await service.create(request,'owner');
  assert.equal((await finished(service,job.id)).status,'needs_review');
  assert.equal((await service.create(request,'owner')).id,job.id);
  assert.equal(api.calls,1); assert.equal(service.config().budgetRemaining,0);
});

test('a zero budget disables spending rather than reverting to a default', async t => {
  const {service,api} = await fixture(t,{budget:0});
  assert.equal(service.config().budgetRemaining,0);
  await assert.rejects(service.create(input(),'owner'), /лимита/);
  assert.equal(api.calls,0);
});

test('30-second audio videos reserve both 15-second scenes and reject incomplete direction before spending', async t => {
  const {service,api} = await fixture(t,{budget:1000});
  const quote = service.estimate({...input(), duration:30, sound:true});
  assert.deepEqual(quote.clipDurations,[15,15]);
  assert.equal(quote.estimatedCost,450);
  await assert.rejects(service.create({...input(),duration:30,sound:true,scenePrompts:['Only one scene description.']},'owner'), /каждой сцены/);
  assert.equal(api.calls,0);
});

test('HTTP rejects cross-site requests, protects paid routes, and serves generated MP4 ranges', async t => {
  const {service,api} = await fixture(t);
  const server = createAppServer(service);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path,body,extra={}) => fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await post('/api/generation/check',{}, {Origin:'https://unrelated.example'})).status,403);
  assert.equal((await post('/api/generation/jobs',input())).status,401); assert.equal(api.calls,0);
  const rejected = await post('/api/generation/jobs',{...input(),duration:60},{'X-Generation-Access':'owner'});
  assert.equal(rejected.status,402); assert.equal(api.calls,0);
  const result = await post('/api/generation/jobs',input(),{'X-Generation-Access':'owner'});
  assert.equal(result.status,202); const job = await result.json();
  const completed = await finished(service,job.id);
  const video = await fetch(base+completed.videos[0].url,{headers:{Range:'bytes=0-11'}});
  assert.equal(video.status,206); assert.equal(Number(video.headers.get('content-length')),12);
  assert.equal((await fetch(base+'/.env')).status,404);
  const config = await (await fetch(base+'/api/generation/config')).text(); assert.ok(!config.includes('pza_test_private'));
});
