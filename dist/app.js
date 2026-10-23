(() => {
  'use strict';
  const events = window.HISTORICAL_EVENTS || [];
  const $ = (id) => document.getElementById(id);
  const esc = (text) => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  let attached = null;
  let attachmentUrl = null;
  let currentEvent = null;
  let toastTimer;
  let creationTimer;
  let creationRequest = 0;
  let clarificationQuery = '';
  let activeLibraryFilter = 'all';
  const historyKey = 'historical-adventure-history-v1';
  const readHistory = () => {
    try { const value = JSON.parse(localStorage.getItem(historyKey) || '[]'); return Array.isArray(value) ? value.filter(x => x && events.some(e => e.id === x.id)).slice(0, 20) : []; }
    catch { return []; }
  };
  const toast = (message) => { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); };
  const showDialog = (id) => { const dialog = $(id); if (!dialog.open) dialog.showModal(); document.body.classList.add('modal-open'); };
  const closeDialog = (id) => $(id).close();
  const showError = (message) => { $('input-error').textContent = message; $('input-error').hidden = false; $('topic-input').setAttribute('aria-invalid','true'); };
  const clearError = () => { $('input-error').hidden = true; $('topic-input').removeAttribute('aria-invalid'); };

  function renderCards(filter = 'all') {
    activeLibraryFilter=filter;
    const visible = events.filter(e => filter === 'all' || e.id === filter || (filter==='generated'&&e.generated));
    $('story-grid').innerHTML = visible.map(event => `<button class="story-card" data-id="${esc(event.id)}" aria-label="Открыть видеорассказ: ${esc(event.title)}"><div class="story-image-wrap"><img src="${esc(event.image)}" alt="${esc(event.imageLabel)}" loading="lazy" width="600" height="360"><span class="story-duration">▷ ${formatTime(event.duration || 0)}</span><span class="story-year">${esc(event.year)}</span></div><p class="story-era">${esc(event.era)}</p><h3>${esc(event.shortTitle)}<span aria-hidden="true">↗</span></h3><p>${esc(event.description)}</p></button>`).join('');
    const n=visible.length;
    const noun=n%10===1 && n%100!==11?'история':n%10>=2 && n%10<=4 && !(n%100>=12 && n%100<=14)?'истории':'историй';
    $('library-count').textContent = `${String(n).padStart(2, '0')} ${noun}`;
  }

  async function loadGeneratedStories() {
    try {
      const response=await fetch('/api/library');
      if(!response.ok)return;
      const list=await response.json();
      if(!Array.isArray(list))return;
      const fresh=list.filter(event=>event&&typeof event.id==='string'&&!events.some(existing=>existing.id===event.id));
      events.unshift(...fresh);
      renderCards(activeLibraryFilter);
      const linked=new URL(location.href).searchParams.get('story');
      if(linked&&!currentEvent&&events.some(event=>event.id===linked))openEvent(linked);
    } catch {/* Existing stories remain available if the library endpoint is temporarily offline. */}
  }
  window.addEventListener('historical-library-updated',loadGeneratedStories);

  function activateTab(panel, focus = false) {
    document.querySelectorAll('[data-panel]').forEach(button => {
      const active = button.dataset.panel === panel;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      $(`panel-${button.dataset.panel}`).hidden = !active;
      if (active && focus) button.focus();
    });
  }

  function openEvent(id) {
    const event = events.find(e => e.id === id);
    if (!event) return;
    currentEvent = event;
    ['choice-dialog','history-dialog'].forEach(dialogId => { if ($(dialogId).open) closeDialog(dialogId); });
    $('story-title').textContent = event.title;
    $('story-meta').innerHTML = `<span>${esc(event.date)}</span><span aria-hidden="true">·</span><span>${esc(event.place)}</span>`;
    $('story-description').textContent = event.description;
    $('video-label').textContent = event.imageLabel;
    document.querySelector('.video-actions > span').textContent=event.narrated===false?'Видеорассказ готов':'Видеорассказ готов · Русская озвучка';
    $('tab-transcript').textContent=event.narrated===false?'Текст рассказа':'Текст озвучки';
    const video = $('story-video');
    video.pause(); video.poster = event.image;
    video.src = event.video || `assets/${event.id}.mp4`;
    video.load();
    $('video-error').hidden = true;
    $('download-video').href = video.getAttribute('src');
    $('download-video').download = `A-Historical-adventure-${event.id}.mp4`;
    $('panel-transcript').innerHTML = event.scenes.map((scene, i) => `<article class="transcript-scene"><button data-seek="${scene.start || 0}" aria-label="Перейти к сцене ${i + 1}, ${formatTime(scene.start || 0)}">${String(i + 1).padStart(2,'0')}<span class="sr-only"> ${formatTime(scene.start || 0)}</span></button><div><h3>${esc(scene.title)}</h3><p>${esc(scene.text)}</p></div></article>`).join('');
    $('panel-sources').innerHTML = `<p style="font-size:12px;color:var(--muted);margin-bottom:20px">${esc(event.sourceNote||'Материалы для проверки рассказа. Иллюстрация сама по себе не подтверждает исторические детали.')}</p>` + event.sources.map(source => `<a class="source-item" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(source.title)} ↗</strong><p>${esc(source.note)}</p><small>${esc(new URL(source.url).hostname)}</small></a>`).join('');
    renderQuiz(event);
    activateTab('transcript');
    showDialog('story-dialog');
    const saved = [{id, at: new Date().toISOString()}, ...readHistory().filter(x => x.id !== id)].slice(0, 20);
    try { localStorage.setItem(historyKey, JSON.stringify(saved)); } catch { /* Private browsing can disable storage. */ }
  }

  function renderQuiz(event) {
    if(!event.quiz.length){$('panel-quiz').innerHTML='<p class="generation-note">Это короткая видеосцена. Посмотрите текст озвучки и проверьте сведения по источникам.</p>';return;}
    $('panel-quiz').innerHTML = `<form id="quiz-form"><p style="font-size:12px;color:var(--muted);margin-bottom:22px">Три вопроса по рассказу. Можно вернуться к тексту и проверить факты.</p>${event.quiz.map((q,i) => `<fieldset class="quiz-question"><legend>${i + 1}. ${esc(q.question)}</legend>${q.options.map((option,j) => `<label class="quiz-option"><input type="radio" name="question-${i}" value="${j}" required><span>${esc(option)}</span></label>`).join('')}</fieldset>`).join('')}<p id="quiz-error" class="quiz-error" role="alert" hidden>Выберите ответ на каждый вопрос.</p><button type="submit" class="quiz-submit">Проверить ответы</button><div id="quiz-result" class="quiz-result" role="status" hidden></div></form>`;
    $('quiz-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      if (event.quiz.some((_,i) => !data.has(`question-${i}`))) { $('quiz-error').hidden = false; return; }
      $('quiz-error').hidden = true;
      const results = event.quiz.map((q,i) => Number(data.get(`question-${i}`)) === q.correct);
      const correct = results.filter(Boolean).length;
      $('quiz-result').innerHTML = `<h3>${correct} из ${event.quiz.length} ${correct === 3 ? '— всё верно!' : '— разберём ответы'}</h3>${event.quiz.map((q,i) => `<p><strong>${results[i] ? '✓' : '↗'} Вопрос ${i + 1}.</strong> ${esc(q.explanation)}</p>`).join('')}`;
      $('quiz-result').hidden = false;
      $('quiz-result').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    });
    $('quiz-form').noValidate = true;
  }

  function chooseEvent(candidates, description, title) {
    $('choice-title').textContent = title || 'Какое событие вы имеете в виду?';
    $('choice-description').textContent = description;
    $('choice-list').innerHTML = candidates.map(event => `<button class="choice-card" data-create="${esc(event.id)}"><span><strong>${esc(event.title)}</strong><small>${esc(event.date)} · ${esc(event.era)}</small></span><span aria-hidden="true">↗</span></button>`).join('');
    showDialog('choice-dialog');
  }

  function editDistance(a,b) {
    if (Math.abs(a.length-b.length)>1) return 2;
    const row = Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){let prev=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));prev=old;}}
    return row[b.length];
  }
  function findEvents(query) {
    const normalized = query.toLowerCase().replace(/ё/g,'е');
    const tokens = normalized.match(/[\p{L}\p{N}]+/gu) || [];
    return events.map(event => ({event, score:[...event.keywords,...(event.searchPhrases||[])].reduce((score, word) => {
      const key = word.replace(/ё/g,'е');
      const matched = /^\d+$/.test(key) ? new RegExp(`(^|\\D)${key}(\\D|$)`).test(normalized) : normalized.includes(key);
      const fuzzy = !matched && key.length>=6 && !key.includes(' ') && tokens.some(token=>token.length>=6 && editDistance(token,key)<=1);
      return score + (matched ? (key.includes(' ')?3:2) : fuzzy ? 1 : 0);
    },0)})).filter(x => x.score > 0).sort((a,b) => b.score - a.score).map(x => x.event);
  }

  function clarifyEra(query) {
    clarificationQuery = query;
    $('choice-title').textContent = 'В какое время это произошло?';
    $('choice-description').textContent = 'В описании пока не хватает деталей. Выберите эпоху — это поможет уточнить событие.';
    const eras=[...new Map(events.map(event=>[event.era,event])).values()];
    $('choice-list').innerHTML = eras.map(event=>`<button class="choice-card" data-era="${esc(event.id)}"><span><strong>${esc(event.era)}</strong><small>${esc(event.eraHint || (event.id==='rome'?'Античность, арены и императоры':event.id==='borodino'?'XIX век, армии и полководцы':'XX век, открытия и космонавтика'))}</small></span><span aria-hidden="true">→</span></button>`).join('')+'<button class="text-link" data-clarify-all>Не помню эпоху — показать варианты</button>';
    showDialog('choice-dialog');
  }

  function clarifyDetail(id) {
    const event = events.find(e=>e.id===id); if(!event) return;
    const sameEra=events.filter(e=>e.era===event.era);
    if(sameEra.length>1){chooseEvent(sameEra,'Выберите событие этой эпохи, которое ближе всего к описанию.','Какая история вам нужна?');return;}
    const detail = event.clarification || {question:'Эта тема подходит к вашему описанию?',answer:event.title};
    $('choice-title').textContent = detail.question;
    $('choice-description').textContent = 'Уточним ещё одну деталь перед созданием видеорассказа.';
    $('choice-list').innerHTML = `<button class="choice-card" data-confirm="${esc(id)}"><span><strong>${esc(detail.answer)}</strong><small>Да, это похоже на моё описание</small></span><span aria-hidden="true">→</span></button><button class="choice-card" data-clarify-all><span><strong>Другое событие</strong><small>Посмотреть близкие темы</small></span><span aria-hidden="true">→</span></button>`;
  }

  function startCreation(id) {
    const event=events.find(e=>e.id===id); if(!event) return;
    if($('choice-dialog').open) closeDialog('choice-dialog');
    openEvent(id);
  }

  function clearAttachment() {
    if (attachmentUrl) URL.revokeObjectURL(attachmentUrl);
    attachmentUrl = null; attached = null;
    $('attachment').hidden = true; $('attachment-preview').hidden = true;
    $('attachment-preview').removeAttribute('src'); $('file-input').value = '';
  }

  let fileSequence = 0;
  async function attachFile(file) {
    const sequence = ++fileSequence;
    clearAttachment(); clearError();
    if (!file) return;
    if (!file.size) { showError('Файл пустой. Выберите другое изображение или текстовый файл.'); return; }
    if (file.size > 10 * 1024 * 1024) { showError('Файл больше 10 МБ. Выберите файл поменьше.'); return; }
    try {
      const bytes = new Uint8Array(await file.slice(0,16).arrayBuffer());
      if (sequence !== fileSequence) return;
      const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const isPng = [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b);
      const isWebp = String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
      if (isJpeg || isPng || isWebp) {
        const url = URL.createObjectURL(file);
        const img = new Image(); img.src = url;
        try { await img.decode(); } catch { URL.revokeObjectURL(url); throw new Error('Изображение повреждено. Попробуйте другой файл.'); }
        if (sequence !== fileSequence) { URL.revokeObjectURL(url); return; }
        attachmentUrl = url; attached = {kind:'image', name:file.name, mime:isJpeg?'image/jpeg':isPng?'image/png':'image/webp'};
        $('attachment-preview').src = url; $('attachment-preview').hidden = false;
      } else if (/\.txt$/i.test(file.name)) {
        const content = (await file.text()).trim();
        if (sequence !== fileSequence) return;
        if (!content) throw new Error('В текстовом файле нет текста.');
        if (content.length > 10000) throw new Error('Выберите текст до 10 000 символов.');
        if (content.includes('\u0000')) throw new Error('Не удалось прочитать файл как текст. Используйте .txt в UTF-8.');
        attached = {kind:'text',name:file.name,content};
      } else { throw new Error('Поддерживаются изображения JPG, PNG, WebP и текстовые файлы .txt.'); }
      $('attachment-name').textContent = file.name;
      $('attachment').hidden = false;
      toast(attached.kind === 'image' ? 'Изображение прикреплено. Добавьте описание или уточните тему на следующем шаге.' : 'Текстовый файл прикреплён. Можно перейти к созданию рассказа.');
    } catch (error) { showError(error.message || 'Не удалось прочитать файл. Выберите другой.'); }
  }

  $('topic-form').addEventListener('submit', async (e) => {
    e.preventDefault(); clearError();
    if (!events.length) { showError('Библиотека не загрузилась. Обновите страницу.'); return; }
    const query = [$('topic-input').value.trim(), attached?.content || ''].join(' ').trim();
    if (!query && !attached) { showError('Напишите название события, опишите его или прикрепите файл.'); $('topic-input').focus(); return; }
    if (window.HistoricalGenerator.mode === 'generate') {
      if (query.length < 10 || query.length > 2000) { showError('Для новой сцены добавьте описание от 10 до 2000 символов.'); return; }
      await window.HistoricalGenerator.open({prompt:query,imageFile:attached?.kind==='image'?$('file-input').files[0]:null,imageMime:attached?.mime});
      return;
    }
    const matches = findEvents(query);
    if (attached?.kind === 'image') {
      if(matches.length) chooseEvent(matches, 'Подтвердите событие на изображении, чтобы видеорассказ соответствовал вашей теме.');
      else clarifyEra(query);
    } else if (matches.length === 1) startCreation(matches[0].id);
    else if (matches.length > 1) chooseEvent(matches, 'В описании есть признаки нескольких событий. Выберите нужную тему.');
    else clarifyEra(query);
  });

  $('topic-input').addEventListener('input',clearError);
  $('attach-button').addEventListener('click',() => $('file-input').click());
  $('file-input').addEventListener('change',() => attachFile($('file-input').files[0]));
  $('remove-file').addEventListener('click',() => { ++fileSequence; clearAttachment(); clearError(); });
  $('topic-form').addEventListener('dragover', e => { e.preventDefault(); });
  $('topic-form').addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) attachFile(e.dataTransfer.files[0]); });
  document.addEventListener('click',(e) => {
    const target = e.target.closest('button');
    if (!target) return;
    if (target.dataset.id) openEvent(target.dataset.id);
    else if (target.dataset.create) startCreation(target.dataset.create);
    else if (target.dataset.era) clarifyDetail(target.dataset.era);
    else if (target.dataset.confirm) { const event=events.find(x=>x.id===target.dataset.confirm);chooseEvent([event], 'На основе уточнений выбрана эта тема. Подтвердите событие и перейдите к созданию видео.', 'Создадим рассказ об этом?'); }
    else if (target.dataset.clarifyAll!==undefined) { const matches=findEvents(clarificationQuery);chooseEvent(matches.length?matches:events,'Выберите событие, которое ближе всего к вашему описанию.','Уточните событие'); }
    else if (target.dataset.topic) { $('topic-input').value = events.find(x => x.id === target.dataset.topic)?.title || ''; clearError(); if(window.HistoricalGenerator.mode==='generate') window.HistoricalGenerator.open({prompt:$('topic-input').value}); else startCreation(target.dataset.topic); }
    else if (target.dataset.filter) { document.querySelectorAll('[data-filter]').forEach(b => { const active = b === target; b.classList.toggle('active',active); b.setAttribute('aria-pressed',String(active)); }); renderCards(target.dataset.filter); }
    else if (target.dataset.close) closeDialog(target.dataset.close);
    else if (target.dataset.panel) activateTab(target.dataset.panel);
    else if (target.dataset.seek !== undefined) { $('story-video').currentTime = Number(target.dataset.seek); $('story-video').play().catch(() => toast('Нажмите «Воспроизвести» в плеере.')); }
  });
  document.querySelector('.story-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    const tabs = [...document.querySelectorAll('[data-panel]')];
    let index = tabs.findIndex(b => b.getAttribute('aria-selected') === 'true');
    index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); activateTab(tabs[index].dataset.panel,true);
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close',() => { if (dialog.id === 'story-dialog') $('story-video').pause(); if(dialog.id==='creation-dialog'){clearTimeout(creationTimer);++creationRequest;} if (![...document.querySelectorAll('dialog')].some(d => d.open)) document.body.classList.remove('modal-open'); });
    dialog.addEventListener('click',e => { if (e.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); });
  });
  $('story-video').addEventListener('error',() => { if (currentEvent) $('video-error').hidden = false; });
  function renderHistory() {
    const items = readHistory();
    $('clear-history').hidden = !items.length;
    $('history-list').innerHTML = items.length ? items.map(item => { const event = events.find(x => x.id === item.id); const date = new Date(item.at); const label = Number.isFinite(date.getTime()) ? date.toLocaleDateString('ru-RU',{day:'numeric',month:'long'}) : ''; return `<button class="choice-card" data-id="${esc(event.id)}"><span><strong>${esc(event.shortTitle)}</strong><small>${esc(event.era)} · ${esc(label)}</small></span><span aria-hidden="true">↗</span></button>`; }).join('') : '<p class="history-empty">Здесь появятся открытые вами истории.<br>Начните с любого события в библиотеке.</p>';
  }
  $('history-button').addEventListener('click',() => { renderHistory(); showDialog('history-dialog'); });
  $('clear-history').addEventListener('click',() => { try { localStorage.removeItem(historyKey); } catch { /* No persistent storage. */ } renderHistory(); toast('История просмотров очищена.'); });

  function resetBranch() {
    $('branch-content').innerHTML = '<p class="branch-story">Вы — советник правителя. Переговоры с соседним государством зашли в тупик. У сторон есть спорная территория, ограниченные ресурсы и возможность отложить столкновение.<br><br>Какой шаг вы предложите?</p><div class="branch-choices"><button data-branch="talk">01 &nbsp; Продолжить переговоры ↗</button><button data-branch="plan">02 &nbsp; Изменить военный план ↗</button></div>';
  }
  $('what-if-button').addEventListener('click',() => { resetBranch(); showDialog('branch-dialog'); });
  $('branch-content').addEventListener('click', e => {
    const button = e.target.closest('button'); if (!button) return;
    if (button.dataset.reset !== undefined) { resetBranch(); return; }
    if (!button.dataset.branch) return;
    const talk = button.dataset.branch === 'talk';
    $('branch-content').innerHTML = `<div class="branch-outcome"><p class="eyebrow" style="margin-top:24px">Вы выбрали: ${talk ? 'переговоры' : 'изменение плана'}</p><h3>${talk ? 'Время для компромисса' : 'Время для подготовки'}</h3><p>${talk ? 'Допустим, стороны согласились на временное перемирие. Появилось время обсудить границы и снабжение. Это могло снизить риск немедленного столкновения, но затягивание переговоров также дало бы сопернику время укрепиться.' : 'Допустим, правитель отложил наступление и укрепил оборону. Это могло сохранить ресурсы и улучшить позиции, но соперник тоже получил бы дополнительное время, а союзники могли бы усомниться в решительности правителя.'}</p><p><strong>Вопрос для обсуждения:</strong> ${talk ? 'какие условия сделали бы перемирие выгодным обеим сторонам?' : 'какие сведения нужны, чтобы сравнить риск ожидания с риском наступления?'}</p><div class="branch-real">Это один возможный исход при заданных допущениях. Чтобы применить модель к реальному событию, нужно изучить источники, ресурсы сторон и решения, которые они действительно приняли.</div><button type="button" class="text-link" data-reset>Попробовать другой путь ↻</button></div>`;
  });
  renderCards();
  const linkedStory = new URL(location.href).searchParams.get('story');
  if (linkedStory && events.some(event => event.id === linkedStory)) openEvent(linkedStory);
  loadGeneratedStories();
})();
