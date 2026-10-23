import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { GenerationService, RequestError } from './generation.mjs';

const root = resolve(import.meta.dirname, 'dist');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8', '.wav': 'audio/wav' };
function json(res, status, data, head = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(head ? undefined : JSON.stringify(data));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(415, 'Отправьте JSON-запрос.');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 15 * 1024 * 1024) throw new RequestError(413, 'Прикреплённый файл слишком большой.');
    chunks.push(chunk);
  }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || Array.isArray(data) || typeof data !== 'object') throw 0; return data; }
  catch { throw new RequestError(400, 'Не удалось прочитать запрос.'); }
}

export function createAppServer(generation, options={}) {
  const attempts = new Map();
  const trustProxy=options.trustProxy??process.env.TRUST_PROXY==='true';
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const safeView=job=>{const {estimatedCost,actualCost,...view}=job;return {...view,error:job.error?'Не удалось завершить создание видео. Попробуйте позже.':null};};
  function session(req,res) {
    // Посетитель получает сессию автоматически; служебный пароль в браузер не передаётся.
    let token=String(req.headers.cookie||'').match(/(?:^|;\s*)ha_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if(!token) {
      token=randomBytes(32).toString('hex');
      const secure=req.socket.encrypted||(trustProxy&&req.headers['x-forwarded-proto']==='https');
      res.setHeader('Set-Cookie',`ha_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure?'; Secure':''}`);
    }
    return hash(token);
  }
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.origin) {
          let same = false;
          try { same = new URL(req.headers.origin).host === req.headers.host; } catch { /* Invalid origins stay denied. */ }
          if (!same) throw new RequestError(403, 'Запрос должен быть отправлен с этого сайта.');
        }
        await generation.ready;
        if (['GET','HEAD'].includes(req.method) && url.pathname === '/api/library') return json(res,200,await generation.library(),req.method==='HEAD');
        const password = req.headers['x-generation-access'] || '';
        const publicRequest=generation.publicAccess&&!password;
        if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/generation/config') {
          if(generation.publicAccess&&password)generation.authorize(password);
          if(publicRequest)session(req,res);
          return json(res, 200, publicRequest?generation.publicConfig():generation.config(), req.method === 'HEAD');
        }
        const jobMatch = url.pathname.match(/^\/api\/generation\/jobs\/([a-f0-9-]{36})$/);
        if (req.method === 'GET' && jobMatch) {
          if(!publicRequest)return json(res,200,generation.get(jobMatch[1],password));
          const ownerHash=session(req,res),job=generation.jobs.get(jobMatch[1]);
          if(!job||job.ownerHash!==ownerHash)throw new RequestError(404,'Задание не найдено.');
          return json(res,200,safeView(generation.get(job.id,generation.password)));
        }
        if (req.method === 'POST' && ['/api/generation/check', '/api/generation/jobs'].includes(url.pathname)) {
          // Доверяем IP от Caddy только в явно включённой схеме с закрытым портом приложения.
          const forwarded=String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();
          const ip = trustProxy&&isIP(forwarded)?forwarded:req.socket.remoteAddress;
          const record = attempts.get(ip) || { count: 0, until: Date.now() + 60000 };
          if (record.until < Date.now()) { record.count = 0; record.until = Date.now() + 60000; }
          if (++record.count > 20) throw new RequestError(429, 'Слишком много запросов. Подождите минуту.');
          attempts.set(ip, record);
          if (attempts.size > 1000) for (const [address, item] of attempts) if (item.until < Date.now()) attempts.delete(address);
          const input = await body(req);
          if (url.pathname.endsWith('/check')) return json(res, 200, await generation.check(password));
          if(!publicRequest)return json(res,202,await generation.create(input,password));
          const ownerHash=session(req,res),clientHash=createHmac('sha256',generation.password).update(ip).digest('hex');
          try {
            const job=await generation.create({...input,automatic:true,scenePrompts:undefined},generation.password,{publicAccess:true,ownerHash,clientHash});
            return json(res,202,safeView(job));
          } catch(error) {
            if(error.status===402||error.status===503)throw new RequestError(503,'Создание новых видео временно недоступно. Готовые истории можно посмотреть в библиотеке.');
            throw error;
          }
        }
        throw new RequestError(404, 'Метод API не найден.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      if (url.pathname === '/healthz') return json(res, 200, { status: 'ok', service: 'historical-adventure' }, req.method === 'HEAD');
      let path;
      if (url.pathname.startsWith('/generated/')) {
        await generation.ready;
        const output = url.pathname.match(/^\/generated\/([a-f0-9-]{36})\/(video-[12]\.mp4|poster-[12]\.jpg)$/);
        path = output && generation.outputPath(output[1], output[2]);
        if (!path) throw new RequestError(404, 'Видео не найдено.');
      } else {
        path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (path !== root && !path.startsWith(root + sep)) throw new RequestError(403, 'Доступ запрещён.');
      }
      const info = await stat(path);
      if (!info.isFile()) throw new RequestError(404, 'Файл не найден.');
      const headers = { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'Cache-Control': path.endsWith('.mp4') ? 'private, max-age=3600' : 'no-cache' };
      let start = 0, end = info.size - 1, status = 200;
      if (req.headers.range) {
        const range = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
        if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
        start = Number(range[1]); end = Math.min(range[2] ? Number(range[2]) : end, end);
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      }
      res.writeHead(status, { ...headers, 'Content-Length': info.size ? end - start + 1 : 0 });
      if (req.method === 'HEAD' || !info.size) { res.end(); return; }
      const stream = createReadStream(path, { start, end });
      res.once('close', () => stream.destroy());
      stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof RequestError ? error.status : error.code === 'ENOENT' ? 404 : 500,
        { error: error instanceof RequestError ? error.message : error.code === 'ENOENT' ? 'Файл не найден.' : 'Не удалось выполнить запрос.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.loadEnvFile(resolve(import.meta.dirname, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  if (process.env.POLZA_API_KEY && !['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.GENERATION_PASSWORD)
    throw new Error('Set GENERATION_PASSWORD in .env before exposing paid generation on a public server.');
  const generation = new GenerationService({ directory: process.env.DATA_DIR || resolve(import.meta.dirname, 'data') });
  await generation.ready;
  const server = createAppServer(generation);
  server.listen(port, host, () => console.log(`Local: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { generation.close(); server.close(); });
}
