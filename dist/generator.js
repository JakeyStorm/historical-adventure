(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const storage = { get() { try { return sessionStorage.getItem('historical-active-generation') || ''; } catch { return ''; } },
    set(id) { try { if (id) sessionStorage.setItem('historical-active-generation', id); else sessionStorage.removeItem('historical-active-generation'); } catch { /* Storage is optional. */ } } };
  let mode = 'generate', config, reference, imageMime, busy = false, tracking = false, requestId, submitted, activeId = storage.get();
  const dialog = $('generation-dialog'), controls = ['generation-prompt','generation-duration','generation-count','generation-sound','generation-narration','generation-voice','generation-publish'];
  function error(message) { $('generation-error').textContent = message; $('generation-error').hidden = !message; }
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, credentials:'same-origin',headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(40000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const failure = new Error(data.error || 'Не удалось получить ответ сервера.'); failure.status = response.status; throw failure; }
    return data;
  }
  function update() {
    $('generation-voice').disabled=busy||Boolean(submitted)||!$('generation-narration').checked;
    const max=config?.maxDurationByCount?.[$('generation-count').value]??60;
    for(const option of $('generation-duration').options)option.disabled=Number(option.value)>max;
    if(Number($('generation-duration').value)>max)$('generation-duration').value=String(max||3);
    $('generation-start').textContent = activeId || submitted ? 'Проверить готовность' : 'Создать видео';
    $('generation-start').disabled = busy || (!activeId && !submitted && (!config?.enabled || $('generation-prompt').value.trim().length < 10));
  }
  async function open(options) {
    error('');
    if (!dialog.open) { dialog.showModal(); document.body.classList.add('modal-open'); }
    try {
      config = await api('/api/generation/config');
      if (activeId) { $('generation-settings').hidden = false; update(); await track(activeId); return; }
      reference = options.imageFile; imageMime = options.imageMime || reference?.type;
      submitted = null; requestId = crypto.randomUUID();
      $('generation-settings').hidden = false; $('generation-status').hidden = true; $('generation-results').hidden = true; $('generation-timeline').hidden=true;
      $('generation-plan').hidden=true;
      $('generation-results').replaceChildren(); $('generation-prompt').value = options.prompt || '';
      controls.forEach(id => { $(id).disabled = false; });
      $('generation-reference').hidden = !reference;
      $('generation-reference').textContent = reference ? `Опорное изображение: ${reference.name}. При запуске оно будет передано в Polza.` : '';
      if (!config.enabled) error('Создание новых видео временно недоступно. Готовые истории можно посмотреть в библиотеке.');
      update();
    } catch (failure) { error(failure.message || 'Сервер генерации недоступен.'); }
  }
  function render(job) {
    $('generation-settings').hidden = true; $('generation-status').hidden = false;
    const labels = { queued:'Задание принято.', planning:'Сайт пишет исторический сценарий.',generating:'Создаём видеоряд.',narrating:'Записываем русского диктора.', assembling:'Сводим голос, видео и фон.',publishing:'Сохраняем видео в библиотеку.', completed:'Видео готово.', failed:'Не удалось завершить создание.', needs_review:'Не удалось завершить создание.' };
    $('generation-status').textContent = `${labels[job.status] || 'Проверяем статус.'} Готово сцен: ${job.completedClips} из ${job.totalClips}.`;
    if (job.error) error(job.error);
    $('generation-timeline').replaceChildren();
    $('generation-timeline').hidden=!job.timeline?.length;
    (job.timeline||[]).forEach(step=>{const item=document.createElement('li');item.textContent=step.message;$('generation-timeline').append(item);});
    $('generation-plan').hidden=!job.plan;
    if(job.plan){$('generation-plan-title').textContent=job.plan.title;$('generation-plan-text').textContent=job.plan.narration;}
    if (job.status === 'completed') {
      $('generation-results').replaceChildren(); $('generation-results').hidden = false;
      job.videos.forEach((result, index) => {
        const article = document.createElement('article'), title = document.createElement('h3'), video = document.createElement('video'), link = document.createElement('a');
        title.textContent = job.videos.length === 1 ? 'Ваша видеосцена' : `Ролик ${index + 1}`;
        video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.src = result.url;
        link.className = 'text-link'; link.href = result.url; link.download = `Historical-adventure-${job.id}-${index + 1}.mp4`; link.textContent = 'Скачать MP4 ↓';
        article.append(title, video, link); $('generation-results').append(article);
        if(result.storyId){const library=document.createElement('a');library.className='text-link';library.href='?story='+encodeURIComponent(result.storyId);library.textContent='Открыть в библиотеке ↗';article.append(library);}
      });
      if(job.automatic)$('generation-status').textContent+=job.narration?' Русский диктор добавлен автоматически.':' Создано сайтом автоматически.';
      if(job.narration&&job.automatic)$('generation-status').textContent+=` Голос: ${job.voice||'onyx'}.`;
      if(job.libraryIds?.length){$('generation-status').textContent+=' Ролик сохранён в библиотеке.';window.dispatchEvent(new Event('historical-library-updated'));}
    }
    if (['completed','failed','needs_review'].includes(job.status)) { activeId = ''; storage.set(''); return false; }
    return true;
  }
  async function track(id) {
    if (tracking) return;
    tracking = true; let failures = 0;
    try {
      while (dialog.open && activeId === id) {
        try { const job = await api(`/api/generation/jobs/${id}`); failures = 0; error(''); if (!render(job)) break; }
        catch (failure) {
          if (failure.status === 401 || failure.status === 403) { error('Не удалось получить задание. Обновите страницу и попробуйте позже.'); break; }
          if (failure.status === 404) { activeId = ''; storage.set(''); error('Ранее отправленное задание не найдено.'); break; }
          if (++failures >= 4) { error('Соединение прервано. Задание сохранено. Откройте создание видео ещё раз, чтобы проверить результат.'); break; }
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } finally { tracking = false; }
  }
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
      reader.onload = () => resolve({ mime: imageMime, data: String(reader.result).split(',')[1] }); reader.readAsDataURL(file);
    });
  }
  $('generation-start').addEventListener('click', async () => {
    if (busy) return;
    busy = true; error(''); update();
    try {
      if (activeId) { await track(activeId); return; }
      if (!submitted) submitted = { requestId, prompt:$('generation-prompt').value.trim(), duration:Number($('generation-duration').value),
        count:Number($('generation-count').value), sound:$('generation-sound').checked, automatic:true,narration:$('generation-narration').checked,voice:$('generation-voice').value,publish:$('generation-publish').checked,image:reference ? await readImage(reference) : null };
      controls.forEach(id => { $(id).disabled = true; });
      const job = await api('/api/generation/jobs', { method:'POST', body:JSON.stringify(submitted) });
      activeId = job.id; storage.set(job.id); if (render(job)) await track(job.id);
    } catch (failure) {
      error(failure.message || 'Нет ответа. Задание сохранено — попробуйте проверить готовность ещё раз.');
      if (failure.status >= 400 && failure.status < 500) { submitted = null; controls.forEach(id => { $(id).disabled = false; }); }
    } finally { busy = false; update(); }
  });
  controls.forEach(id => $(id).addEventListener('input', update));
  dialog.addEventListener('close', () => dialog.querySelectorAll('video').forEach(video => video.pause()));
  function setMode(value) { mode = value; $('mode-generate').setAttribute('aria-pressed', String(mode === 'generate')); $('mode-library').setAttribute('aria-pressed', String(mode === 'library')); }
  $('mode-generate').addEventListener('click', () => setMode('generate'));
  $('mode-library').addEventListener('click', () => setMode('library'));
  window.HistoricalGenerator = { open, get mode() { return mode; } };
  const linkedJob = new URL(location.href).searchParams.get('generation');
  if (/^[a-f0-9-]{36}$/i.test(linkedJob || '')) {
    activeId = linkedJob; storage.set(linkedJob);
    open({prompt:''});
  }
})();
