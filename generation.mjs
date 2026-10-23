import { mkdir, readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, findBackground, writeStory, makeSpeech, exportStory, saveLibraryStory, StoryError, SCRIPT_MODEL, voiceModelFor, VOICES, SCRIPT_RESERVE_RUB, voiceReserve } from './story.mjs';

const exec = promisify(execFile);
const terminal = new Set(['completed', 'failed', 'needs_review']);
const round = value => Math.round(value * 100) / 100;
const number = (value, fallback, allowZero = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) throw new Error('Invalid Polza spending limit');
  return parsed;
};
// "unlimited" removes our spending ceiling; the provider's real balance is still checked.
const moneyLimit=(value,fallback,allowZero=false)=>value==='unlimited'?Infinity:number(value,fallback,allowZero);
export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class PolzaClient {
  constructor(key, fetcher = fetch) { this.key = key; this.fetcher = fetcher; }
  async request(path, body, options = {}) {
    let response;
    try {
      response = await this.fetcher(`https://polza.ai/api/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(options.timeout || 30000), redirect: 'error',
      });
    } catch { throw new RequestError(502, 'Нет ответа от Polza. Проверьте соединение и историю заданий перед повторным запуском.'); }
    if (options.audio && response.ok && response.headers.get('content-type')?.startsWith('audio/')) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if(bytes.length > 8*1024*1024)throw new RequestError(502,'Сервис озвучки вернул слишком большой файл.');
      return {audio:bytes.toString('base64'),contentType:response.headers.get('content-type')};
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      const messages = {
        401: 'Ключ Polza не принят. Владельцу сайта нужно проверить настройки подключения.',
        402: 'Недостаточно средств или исчерпан лимит API-ключа Polza.',
        403: 'Ключу Polza запрещена эта операция или модель.',
        429: 'Polza временно ограничила запросы. Подождите перед проверкой статуса.',
      };
      const noProvider = /noProviders|price|provider/i.test(result?.error?.metadata?.reason || '');
      const error = new RequestError(response.status || 502, noProvider
        ? 'Нет доступного провайдера в установленном пределе цены. Деньги автоматически повторно не списываем.'
        : messages[response.status] || 'Polza не выполнила запрос. Проверьте его историю в кабинете.');
      error.definiteRejection = response.status >= 400 && response.status < 500;
      throw error;
    }
    return result;
  }
  async check() {
    const [key, balance] = await Promise.all([this.request('v1/key'), this.request('v2/balance')]);
    return { valid: true, balance: Number(balance.amount), available: Number(balance.available),
      keyLimit: key.limit ?? null, keyRemaining: key.limit_remaining ?? null };
  }
  submit(input, rate) {
    return this.request('v1/media', { model: 'kling/v3', input, async: true,
      provider: { require_parameters: true, allow_fallbacks: false, sort: 'price',
        max_price: { video_per_second: rate } } });
  }
  status(id) { return this.request(`v1/media/${encodeURIComponent(id)}`); }
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Accept globally routable IPv6 only; IPv4-mapped and local addresses are rejected.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

async function downloadVideo(url, destination) {
  let response;
  for (let redirects = 0; redirects < 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443'))
      throw new Error('Invalid media address');
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Private media address');
    response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Invalid media redirect');
      url = new URL(location, target).href;
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw new Error('Video download failed');
  const limit = 160 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Video too large');
  let size = 0, prefix = Buffer.alloc(0), verified = false;
  const guard = new Transform({ transform(chunk, _, callback) {
    size += chunk.length;
    if (size > limit) return callback(new Error('Video too large'));
    if (!verified) {
      prefix = Buffer.concat([prefix, chunk.subarray(0, Math.max(0, 64 - prefix.length))]);
      if (prefix.length >= 12) {
        if (!prefix.includes(Buffer.from('ftyp'))) return callback(new Error('Response is not MP4'));
        verified = true;
      }
    }
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(destination));
  if (!verified) throw new Error('Empty video');
}

function videoUrl(value, depth = 0) {
  if (depth > 7 || !value) return null;
  if (typeof value === 'string') return /^https:\/\//.test(value) ? value : null;
  if (Array.isArray(value)) { for (const item of value) { const found = videoUrl(item, depth + 1); if (found) return found; } }
  else if (typeof value === 'object') {
    for (const key of ['video_url', 'url', 'video', 'videos', 'files', 'output', 'data']) {
      const found = videoUrl(value[key], depth + 1); if (found) return found;
    }
  }
  return null;
}

function validateImage(image) {
  if (!image) return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mime)
    || typeof image.data !== 'string' || image.data.length > 14 * 1024 * 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new RequestError(400, 'Прикрепите изображение JPG, PNG или WebP до 10 МБ.');
  const bytes = Buffer.from(image.data, 'base64');
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (bytes.length > 10 * 1024 * 1024 || !({ 'image/jpeg': jpeg, 'image/png': png, 'image/webp': webp })[image.mime])
    throw new RequestError(400, 'Не удалось прочитать прикреплённое изображение.');
  return { mime: image.mime, data: image.data };
}

export class GenerationService {
  constructor(options = {}) {
    this.key = options.key ?? process.env.POLZA_API_KEY ?? '';
    this.password = options.password ?? process.env.GENERATION_PASSWORD ?? '';
    this.publicAccess = options.publicAccess ?? process.env.PUBLIC_GENERATION === 'true';
    this.publicMaxCost = moneyLimit(options.publicMaxCost ?? process.env.PUBLIC_MAX_JOB_RUB, 500);
    this.publicJobsPerHour = number(options.publicJobsPerHour ?? process.env.PUBLIC_JOBS_PER_HOUR, 2);
    this.budget = moneyLimit(options.budget ?? process.env.POLZA_BUDGET_RUB, 50, true);
    this.rate = number(options.rate ?? process.env.POLZA_MAX_PRICE_PER_SECOND, 10);
    this.audioRate = number(options.audioRate ?? process.env.POLZA_MAX_AUDIO_PRICE_PER_SECOND, 15);
    this.videoConcurrency=number(options.videoConcurrency??process.env.POLZA_VIDEO_CONCURRENCY,4);
    if(!Number.isInteger(this.videoConcurrency)||this.videoConcurrency>4)throw new Error('Video concurrency must be an integer from 1 to 4');
    this.pause=options.pause||sleep;
    this.directory = resolve(options.directory || process.env.DATA_DIR || 'data');
    this.ffmpeg = options.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
    this.verifyMedia = options.verifyMedia || (()=>exec(this.ffmpeg,['-version'],{timeout:5000,windowsHide:true}));
    this.api = options.api || new PolzaClient(this.key);
    this.download = options.download || downloadVideo;
    this.sources = options.sources || findBackground;
    this.writeStory = options.writeStory || writeStory;
    this.makeSpeech = options.makeSpeech || makeSpeech;
    this.exportStory = options.exportStory || exportStory;
    this.jobs = new Map(); this.published = new Map(); this.saveQueue=new Map();this.lock = Promise.resolve(); this.working = false; this.closed = false;
    this.ready = this.initialize();
  }
  async initialize() {
    await mkdir(join(this.directory, 'jobs'), { recursive: true });
    await mkdir(join(this.directory, 'library'), { recursive: true });
    for (const file of await readdir(join(this.directory, 'jobs'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      // A damaged journal must stop startup; losing its reservations could allow duplicate spend.
      const job = JSON.parse(await readFile(join(this.directory, 'jobs', file), 'utf8'));
      if (!job.id || !Number.isFinite(job.estimatedCost) || !Array.isArray(job.clips)) throw new Error('Invalid generation journal');
      if (job.clips.some(clip => clip.phase === 'submitting' && !clip.remoteId)) {
        job.status = 'needs_review'; job.error = 'Ответ на отправленное задание не сохранён. Проверьте историю Polza перед повтором.';
      }
      if ((job.scriptPhase === 'submitting' && !job.plan) || job.voicePhase === 'submitting') {
        job.status='needs_review';job.error='Ответ платного этапа не сохранён. Автоматический повтор отключён: проверьте историю Polza.';
      }
      this.jobs.set(job.id, job);
      this.published.set(job.id, this.view(job));
    }
    if (this.key) setImmediate(() => this.run());
  }
  config() {
    const reserved = round([...this.jobs.values()].reduce((sum, job) => sum + job.estimatedCost, 0));
    return { enabled: Boolean(this.key), requiresPassword: Boolean(this.password), model: 'Kling 3.0 Standard',
      rate: this.rate, audioRate: this.audioRate, budgetRemaining: Number.isFinite(this.budget)?round(Math.max(0, this.budget - reserved)):null,
      automaticPipeline:true, scriptReserveRub:SCRIPT_RESERVE_RUB, voiceReserves:Object.fromEntries([3,5,15,30,60].map(duration=>[duration,voiceReserve(duration)])),
      durations: [3, 5, 15, 30, 60],voices:VOICES,videoConcurrency:this.videoConcurrency };
  }
  authorize(password) {
    if (!this.key) throw new RequestError(503, 'Генерация ещё не подключена. Владелец сайта должен добавить ключ Polza.');
    const digest = value => createHash('sha256').update(String(value || '')).digest('hex');
    if (this.password && digest(password) !== digest(this.password)) throw new RequestError(401, 'Введите верный код доступа к генерации.');
  }
  publicConfig() {
    const config=this.config();
    return {enabled:config.enabled&&(config.budgetRemaining===null||config.budgetRemaining>=3*this.rate+SCRIPT_RESERVE_RUB),
      automaticPipeline:true,publicAccess:this.publicAccess,voices:VOICES,
      durations:config.durations.filter(duration=>this.estimate({duration,count:1,sound:true,automatic:true}).estimatedCost<=this.publicMaxCost),
      maxDurationByCount:Object.fromEntries([1,2].map(count=>[count,Math.max(0,...config.durations.filter(duration=>this.estimate({duration,count,sound:true,automatic:true}).estimatedCost<=this.publicMaxCost))]))};
  }
  estimate(input) {
    const duration = Number(input.duration), count = Number(input.count || 1), sound = input.sound === true;
    if (![3, 5, 15, 30, 60].includes(duration) || ![1, 2].includes(count)) throw new RequestError(400, 'Выберите допустимую длительность и количество роликов.');
    const rate = sound ? this.audioRate : this.rate;
    const automatic=input.automatic===true,narration=automatic&&input.narration!==false,publish=automatic&&input.publish!==false;
    if(automatic&&input.voice!==undefined&&!VOICES.some(item=>item.id===input.voice))throw new RequestError(400,'Выберите голос из списка.');
    const extras=automatic?SCRIPT_RESERVE_RUB+(narration?voiceReserve(duration):0):0;
    return { duration, count, sound, rate, estimatedCost: round(duration * count * rate+extras),
      ...(automatic?{automatic,narration,publish,extrasReserveRub:extras,...(input.voice!==undefined?{voice:input.voice}:{})}:{}),
      clipDurations: duration > 15 ? Array(duration / 15).fill(15) : [duration] };
  }
  async check(password) { this.authorize(password); return { ...await this.api.check(), ...this.config() }; }
  async persist(job) {
    // Параллельные сцены сохраняют общий журнал строго по очереди: старый снимок не затрёт новый ID.
    const previous=this.saveQueue.get(job.id)||Promise.resolve();
    const saving=previous.then(async()=>{
      const snapshot=structuredClone(job);
      await atomicJson(join(this.directory,'jobs',`${job.id}.json`),snapshot);
      this.published.set(job.id,this.view(snapshot));
    });
    this.saveQueue.set(job.id,saving);
    try {await saving;} finally {if(this.saveQueue.get(job.id)===saving)this.saveQueue.delete(job.id);}
  }
  view(job) {
    return { id: job.id, status: job.status, prompt: job.prompt, duration: job.duration, count: job.count,
      sound: job.sound, estimatedCost: job.estimatedCost, actualCost: job.actualCost ?? null, error: job.error || null,
      completedClips: job.clips.filter(clip => clip.phase === 'completed').length, totalClips: job.clips.length,
      automatic:job.automatic===true,narration:job.narration===true,voice:job.voice||'onyx',plan:job.plan?{title:job.plan.title,narration:job.plan.narration,sourceNote:job.plan.sourceNote}:null,
      timeline:job.timeline||[],libraryIds:job.libraryIds||[],
      videos: job.status === 'completed' ? job.outputs.map((name, i) => ({ url: `/generated/${job.id}/${name}`, title:job.plan?.title||`Видеосцена ${i + 1}`,storyId:job.libraryIds?.[i]||null })) : [] };
  }
  async create(input, password, context = {}) {
    await this.ready; this.authorize(password);
    const previous = this.lock; let release;
    this.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!/^[a-f0-9-]{36}$/i.test(input.requestId || '')) throw new RequestError(400, 'Обновите форму и подтвердите создание видео.');
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt.length < 10 || prompt.length > 2000) throw new RequestError(400, 'Опишите сцену текстом от 10 до 2000 символов.');
      const estimate = this.estimate(input), image = validateImage(input.image);
      const scenePrompts = input.scenePrompts;
      if (scenePrompts !== undefined && (!Array.isArray(scenePrompts)
        || scenePrompts.length !== estimate.clipDurations.length * estimate.count
        || scenePrompts.some(scene => typeof scene !== 'string' || scene.trim().length < 10 || scene.length > 1700)))
        throw new RequestError(400, 'Для каждой сцены нужно отдельное описание от 10 до 1700 символов.');
      const direction = scenePrompts ? { scenePrompts:scenePrompts.map(scene => scene.trim()) } : {};
      const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, ...estimate, image, ...direction })).digest('hex');
      // Один requestId переживает повторный клик и обрыв связи без второго платного задания.
      const existing = [...this.jobs.values()].find(job => job.requestId === input.requestId);
      if (existing) {
        if(context.publicAccess&&existing.ownerHash!==context.ownerHash)throw new RequestError(404,'Задание не найдено.');
        if (existing.fingerprint !== fingerprint) throw new RequestError(409, 'Этот запрос уже использован с другими параметрами.');
        return this.view(existing);
      }
      if(context.publicAccess) {
        if(!this.publicAccess||!context.ownerHash||!context.clientHash)throw new RequestError(403,'Создание видео временно недоступно.');
        if(!estimate.automatic||scenePrompts!==undefined||estimate.estimatedCost>this.publicMaxCost)
          throw new RequestError(400,'Выберите меньшую длительность или один ролик.');
        const recent=[...this.jobs.values()].filter(job=>job.clientHash===context.clientHash&&job.createdAt>Date.now()-3600000);
        if(recent.length>=this.publicJobsPerHour)throw new RequestError(429,'Вы уже создали несколько роликов. Попробуйте через час.');
      }
      if ([...this.jobs.values()].some(job => !terminal.has(job.status))) throw new RequestError(409, 'Предыдущее видео ещё создаётся. Дождитесь результата.');
      const remaining=this.config().budgetRemaining;
      if (remaining!==null&&estimate.estimatedCost > remaining + 0.001) throw new RequestError(402, 'Недостаточно доступного лимита сайта для этой длительности. Выберите короткий ролик или обратитесь к владельцу.');
      if (estimate.clipDurations.length > 1 || estimate.automatic) {
        try { await this.verifyMedia(); }
        catch { throw new RequestError(503, 'Для монтажа видео и озвучки на сервере нужен FFmpeg. Платный запрос не отправлен.'); }
      }
      const account = await this.api.check();
      if (!Number.isFinite(account.available) || account.available + 0.001 < estimate.estimatedCost)
        throw new RequestError(402, 'На балансе Polza или в лимите ключа недостаточно средств для выбранного видео.');
      const clips = [];
      for (let video = 0; video < estimate.count; video++) for (const duration of estimate.clipDurations)
        clips.push({ duration, video, phase: 'pending' });
      const job = { id: randomUUID(), requestId: input.requestId, fingerprint, prompt, image,
        ...estimate, ...direction, ...(context.publicAccess?{ownerHash:context.ownerHash,clientHash:context.clientHash}:{}), clips, status: 'queued', createdAt: Date.now(), outputs: [] };
      await this.persist(job); this.jobs.set(job.id, job);
      setImmediate(() => this.run());
      return this.view(job);
    } finally { release(); }
  }
  get(id, password) { this.authorize(password); const job = this.jobs.get(id); if (!job) throw new RequestError(404, 'Задание не найдено.'); return structuredClone(this.published.get(id) || this.view(job)); }
  outputPath(id, name) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'completed' || (!job.outputs.includes(name) && !(job.posters||[]).includes(name))) return null;
    return join(this.directory, 'generated', id, name);
  }
  async library() {
    await this.ready;
    const entries=[];
    for(const file of await readdir(join(this.directory,'library'))) {
      if(!/^[a-f0-9-]{36}-[12]\.json$/.test(file))continue;
      const entry=JSON.parse(await readFile(join(this.directory,'library',file),'utf8'));
      const job=this.jobs.get(entry.jobId);
      if(job?.status==='completed'&&job.publish===true)entries.push(entry);
    }
    return entries.sort((a,b)=>b.createdAt-a.createdAt).slice(0,200);
  }
  async stage(job,status,message) {
    job.status=status;
    job.timeline ||= [];
    job.timeline.push({at:Date.now(),stage:status,message});
    await this.persist(job);
  }
  async run() {
    if (this.working || this.closed) return;
    this.working = true;
    try {
      for (const job of this.jobs.values()) {
        if (terminal.has(job.status) || this.closed) continue;
        try { if(job.automatic)await this.processAutomatic(job);else await this.process(job); }
        catch (error) {
          job.status = error.definiteRejection ? 'failed' : 'needs_review';
          job.error = error instanceof RequestError || error instanceof StoryError ? error.message
            : 'Не удалось завершить обработку. Проверьте историю Polza: повторный платный запрос автоматически не отправляется.';
          await this.persist(job);
        }
      }
    } finally { this.working = false; }
  }
  async processAutomatic(job) {
    // Журнал фиксируется перед каждым платным этапом: после сбоя сомнительный запрос не повторяем.
    const directory=join(this.directory,'generated',job.id);
    await mkdir(directory,{recursive:true});
    if(!job.plan) {
      await this.stage(job,'planning','Ищем справочные материалы и пишем сценарий.');
      const background=await this.sources(job.prompt);
      job.scriptPhase='submitting';await this.persist(job);
      const result=await this.writeStory(this.api,job,background);
      job.plan=result.plan;job.scriptCost=result.cost;job.scriptPhase='completed';job.scriptModel=SCRIPT_MODEL;
      job.scenePrompts=Array.from({length:job.count},()=>job.plan.scenes.map(scene=>scene.visual)).flat();
      await this.stage(job,'planning','Сценарий написан сайтом автоматически.');
    }
    // Clip submission and downloads are shared with the original worker. Assembly waits for narration.
    await this.generateClips(job,directory);
    if(this.closed)return;
    let voice;
    if(job.narration) {
      voice=join(directory,'narration.mp3');
      if(job.voicePhase!=='completed') {
        await this.stage(job,'narrating','Записываем русский дикторский голос.');
        job.voicePhase='submitting';await this.persist(job);
        const result=await this.makeSpeech(this.api,job.plan.narration,job.voice||'onyx');
        await writeFile(voice,result.bytes,{mode:0o600,flush:true});
        job.voiceCost=result.cost;job.voicePhase='completed';job.voiceModel=result.model||voiceModelFor(job.voice||'onyx');
        await this.stage(job,'narrating','Русская дикторская дорожка сохранена.');
      }
    }
    await this.stage(job,'assembling','Соединяем сцены, голос и фоновые звуки.');
    job.posters ||= [];
    for(let video=0;video<job.count;video++) {
      const clips=job.clips.map((clip,index)=>clip.video===video?`clip-${index}.mp4`:null).filter(Boolean);
      const result=await this.exportStory({ffmpeg:this.ffmpeg,directory,clips,voice,sound:job.sound,duration:job.duration,index:video});
      job.outputs[video]=result.output;job.posters[video]=result.poster;
      await this.persist(job);
    }
    const costs=[...job.clips.map(clip=>clip.cost),job.scriptCost,...(job.narration?[job.voiceCost]:[])];
    job.actualCost=costs.every(cost=>Number.isFinite(cost))?round(costs.reduce((a,b)=>a+b,0)):null;
    if(job.publish) {
      await this.stage(job,'publishing','Сохраняем готовый ролик в библиотеку сайта.');
      job.libraryIds=[];
      for(let video=0;video<job.count;video++)job.libraryIds.push(await saveLibraryStory(this.directory,job,video));
    }
    await this.stage(job,'completed',job.publish?`Видео${job.narration?' с озвучкой':''} готово и автоматически сохранено в библиотеке.`:'Видео готово.');
  }
  async generateClips(job,directory) {
    await this.stage(job,'generating',`Создаём видеосцены: до ${this.videoConcurrency} одновременно.`);
    let cursor=0,limit=this.videoConcurrency,rejections=0;
    while(cursor<job.clips.length&&!this.closed) {
      const batch=[];let submissionError,throttled=false;
      // Отправляем задания с сохранением каждого ID, затем ожидаем их одновременно.
      for(let slot=0;slot<limit&&cursor<job.clips.length&&!this.closed;slot++) {
        const index=cursor,clip=job.clips[index],file=join(directory,`clip-${index}.mp4`);
        if(clip.phase==='completed'&&await stat(file).then(s=>s.size>0,()=>false)){cursor++;continue;}
        try {
          await this.submitClip(job,index);
          batch.push(index);cursor++;rejections=0;
        } catch(error) {
          if(error.status===429&&error.definiteRejection) {
            throttled=true;limit=Math.max(1,batch.length);
          } else submissionError=error;
          break;
        }
      }
      // Даже после ошибки отправки забираем уже оплаченные сцены. Новые в этом случае не заказываем.
      const results=await Promise.allSettled(batch.map(index=>this.collectClip(job,directory,index)));
      const failed=results.find(result=>result.status==='rejected');
      if(submissionError)throw submissionError;
      if(failed)throw failed.reason;
      if(throttled&&!batch.length) {
        if(++rejections>3)throw new RequestError(429,'Сервис временно не принимает новые сцены. Уже готовые фрагменты сохранены.');
        await this.pause(5000*rejections);
      }
    }
  }
  async submitClip(job,index) {
    const clip=job.clips[index];
    if(clip.remoteId)return;
    const prompt=`Historical artistic reconstruction. ${job.scenePrompts[index]} Accurate period materials and natural light. Ambient scene sounds only, no speech, no narration, no singing, no text overlays, no logos.`;
    clip.phase='submitting';clip.submittedAt=Date.now();await this.persist(job);
    let remote;
    try {
      remote=await this.api.submit({prompt,duration:String(clip.duration),mode:'std',sound:job.sound,aspect_ratio:'16:9',images:job.image?[{type:'base64',data:job.image.data}]:[]},job.rate);
    } catch(error) {
      // Повтор разрешён только при явном отказе 429, когда сервис не принял платное задание.
      if(error.definiteRejection){clip.phase=error.status===429?'pending':'rejected';delete clip.submittedAt;await this.persist(job);}
      throw error;
    }
    if(!remote.id)throw new RequestError(502,'Polza не вернула номер задания. Повторный платный запрос не отправляется.');
    clip.remoteId=remote.id;clip.phase='processing';await this.persist(job);
  }
  async collectClip(job,directory,index) {
      const clip=job.clips[index],file=join(directory,`clip-${index}.mp4`);
      let remote;
      while(!this.closed) {
        try {remote=await this.api.status(clip.remoteId);}
        catch(error) {
          if([429,502,503,504].includes(error.status)&&Date.now()-clip.submittedAt<30*60*1000){await this.pause(10000);continue;}
          throw error;
        }
        if(remote.status==='completed')break;
        if(['failed','cancelled'].includes(remote.status))throw new RequestError(502,'Нейросеть не завершила сцену. Проверьте историю Polza.');
        if(Date.now()-clip.submittedAt>30*60*1000)throw new RequestError(504,'Задание сохранено, но генерация превысила время ожидания.');
        await this.pause(5000);
      }
      if(this.closed)return;
      const url=videoUrl(remote.data);if(!url)throw new RequestError(502,'Ссылка на готовую сцену не получена.');
      await this.download(url,file);
      clip.phase='completed';clip.completedAt=Date.now();const cost=Number(remote.usage?.cost_rub??remote.usage?.cost);clip.cost=Number.isFinite(cost)?cost:null;
      await this.persist(job);
  }
  async process(job) {
    const directory = join(this.directory, 'generated', job.id);
    await mkdir(directory, { recursive: true });
    job.status = 'generating'; await this.persist(job);
    const shots = ['Общий план места события.', 'Средний план важных деталей сцены.', 'Плавное наблюдение за действием.', 'Завершающий общий план.'];
    for (let i = 0; i < job.clips.length; i++) {
      const clip = job.clips[i], file = join(directory, `clip-${i}.mp4`);
      if (clip.phase === 'completed' && await stat(file).then(s => s.size > 0, () => false)) continue;
      if (!clip.remoteId) {
        const description = job.scenePrompts?.[i] || job.prompt;
        const framing = job.scenePrompts ? 'Следуйте описанному движению камеры.' : job.clips.length > job.count ? shots[i % 4] : 'Один непрерывный кадр, плавное движение камеры.';
        const prompt = `Историческая художественная реконструкция. ${description}\n${framing} Реалистичные материалы, естественный свет. Без логотипов, надписей и современных предметов вне описанной эпохи.`;
        clip.phase = 'submitting'; clip.submittedAt = Date.now(); await this.persist(job);
        // Never automatically retry this POST: a lost response can still mean a paid accepted task.
        const remote = await this.api.submit({ prompt, duration: String(clip.duration), mode: 'std', sound: job.sound,
          aspect_ratio: '16:9', images: job.image ? [{ type: 'base64', data: job.image.data }] : [] }, job.rate);
        if (!remote.id) throw new RequestError(502, 'Polza не вернула номер задания. Проверьте историю генераций перед повтором.');
        clip.remoteId = remote.id; clip.phase = 'processing'; await this.persist(job);
      }
      let remote;
      while (!this.closed) {
        remote = await this.api.status(clip.remoteId);
        if (remote.status === 'completed') break;
        if (['failed', 'cancelled'].includes(remote.status)) throw new RequestError(502, 'Провайдер не завершил генерацию. Проверьте результат и списание в истории Polza.');
        if (Date.now() - clip.submittedAt > 30 * 60 * 1000) throw new RequestError(504, 'Генерация занимает слишком много времени. Задание сохранено; проверьте его в кабинете Polza.');
        await sleep(5000);
      }
      if (this.closed) return;
      const url = videoUrl(remote.data);
      if (!url) throw new RequestError(502, 'Polza завершила задание, но не вернула ссылку на видео. Проверьте результат в кабинете.');
      await this.download(url, file);
      clip.phase = 'completed'; clip.cost = Number(remote.usage?.cost_rub ?? remote.usage?.cost) || 0;
      await this.persist(job);
    }
    job.status = 'assembling'; await this.persist(job);
    for (let video = 0; video < job.count; video++) {
      const indexes = job.clips.map((clip, index) => clip.video === video ? index : -1).filter(index => index >= 0);
      const name = `video-${video + 1}.mp4`, output = join(directory, name);
      if (indexes.length === 1) await copyFile(join(directory, `clip-${indexes[0]}.mp4`), output);
      else {
        const list = join(directory, `concat-${video}.txt`);
        await writeFile(list, indexes.map(index => `file 'clip-${index}.mp4'`).join('\n'));
        const audio = job.sound ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an'];
        await exec(this.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list,
          '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', ...audio,
          '-movflags', '+faststart', output], { timeout: 600000, maxBuffer: 1024 * 1024, windowsHide: true });
      }
      if (!job.outputs.includes(name)) job.outputs.push(name);
    }
    job.actualCost = round(job.clips.reduce((sum, clip) => sum + clip.cost, 0));
    job.status = 'completed'; await this.persist(job);
  }
  close() { this.closed = true; }
}
