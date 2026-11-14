'use strict';

function createScheduleView({ byId, node, status, run, describe, time }) {
  const navigation = byId('workspace-nav');
  const plan = byId('schedule-plan');
  const queue = byId('schedule-queue');
  const text = byId('schedule-text');
  const sendTime = byId('schedule-time');
  const dayRows = byId('schedule-days');
  const addDayButton = byId('schedule-add-day');
  const search = byId('schedule-search');
  const results = byId('schedule-results');
  const newDraft = byId('schedule-new-draft');
  const stop = byId('schedule-stop-scan');
  const selected = new Set();
  const outcomes = new Map();
  let chats = [];
  let files = [];
  let client;
  let account;
  let limits;
  let view = 'chats';
  let busy = false;
  let scan;
  let summary;

  function button(label, action, className) {
    const element = node('button', label, className);
    element.type = 'button';
    element.disabled = busy;
    element.addEventListener('click', () => run(action));
    return element;
  }

  function localMinute(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }

  function selectedDays() {
    return [...dayRows.querySelectorAll('input')].map(input => input.value);
  }

  function updateDayRows() {
    for (const [index, row] of [...dayRows.children].entries()) {
      row.firstElementChild.setAttribute('aria-label', `День ${index + 1}`);
      const remove = row.lastElementChild;
      remove.setAttribute('aria-label', `Убрать день ${index + 1}`);
      remove.hidden = dayRows.children.length === 1;
    }
    addDayButton.disabled = busy || dayRows.children.length >= limits.deliveries;
    renderSelection();
  }

  function appendDay(value) {
    const row = node('div', '', 'schedule-day');
    const input = node('input');
    input.type = 'date';
    input.required = true;
    input.min = localMinute(new Date()).slice(0, 10);
    input.value = value;
    input.disabled = busy;
    input.addEventListener('input', renderSelection);
    const remove = button('Убрать', () => {
      row.remove();
      updateDayRows();
    });
    row.append(input, remove);
    dayRows.append(row);
    updateDayRows();
    return input;
  }

  function addDay() {
    if (dayRows.children.length >= limits.deliveries) return;
    const today = localMinute(new Date()).slice(0, 10);
    const latest = [today, ...selectedDays()].sort().pop();
    const next = new Date(latest + 'T12:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    appendDay(next.toISOString().slice(0, 10)).focus();
  }

  function setDefaultWhen() {
    const initial = new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000);
    const [day, clock] = localMinute(initial).split('T');
    dayRows.replaceChildren();
    sendTime.value = clock;
    appendDay(day);
  }

  function scheduleDate(day) {
    const value = day + 'T' + sendTime.value;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && localMinute(date) === value ? date.getTime() / 1000 : NaN;
  }

  function deliveryKey(chatId, date) {
    return `${chatId}/${date}`;
  }

  function deliveryDone(chatId, date) {
    const state = outcomes.get(deliveryKey(chatId, date))?.state;
    return state === 'scheduled' || state === 'uncertain';
  }

  function pendingDeliveries(dates) {
    return dates.flatMap(date => [...selected]
      .filter(chatId => !deliveryDone(chatId, date))
      .map(chatId => ({ chatId, date })));
  }

  function setView(next) {
    view = next;
    byId('workspace').hidden = next !== 'chats';
    plan.hidden = next !== 'plan';
    queue.hidden = next !== 'queue';
    for (const tab of navigation.querySelectorAll('button')) {
      tab.setAttribute('aria-pressed', String(tab.dataset.view === next));
    }
  }

  async function open(next) {
    if (next === view) return;
    if ((next === 'plan' && !limits?.deliveries) || (next === 'queue' && !limits)) {
      throw new Error('SCHEDULE_MODULE_REQUIRED');
    }
    setView(next);
    if (next === 'plan') {
      if (!dayRows.children.length) setDefaultWhen();
      byId('schedule-time-zone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
      renderPlan();
      await loadChats();
    } else if (next === 'queue') {
      renderQueue();
      await checkQueue(false);
    }
  }

  function setBusy(value) {
    busy = value;
    stop.disabled = !scan || scan.signal.aborted;
    byId('schedule-cancel-all').disabled = value;
    addDayButton.disabled = value || dayRows.children.length >= limits?.deliveries;
  }

  function renderSelection() {
    byId('schedule-selected').textContent = `Выбрано ${selected.size} из ${limits.chats}`;
    const dates = [...new Set(selectedDays().map(scheduleDate).filter(Number.isFinite))];
    const count = pendingDeliveries(dates).length;
    byId('schedule-deliveries').textContent = `Отправок: ${count} из ${limits.deliveries}`;
  }

  function renderChats() {
    const query = search.value.trim().toLocaleLowerCase('ru');
    const visible = chats.filter(chat => chat.title.toLocaleLowerCase('ru').includes(query));
    const items = visible.map(chat => {
      const item = node('li');
      const label = node('label', '', 'schedule-recipient');
      const check = node('input');
      check.type = 'checkbox';
      check.checked = selected.has(chat.id);
      check.disabled = busy;
      check.addEventListener('change', () => {
        if (check.checked && selected.size >= limits.chats) {
          check.checked = false;
          status(`Выберите до ${limits.chats} чатов за раз.`, true);
        } else {
          if (check.checked) selected.add(chat.id);
          else selected.delete(chat.id);
          status('');
          renderSelection();
        }
      });
      const details = node('span');
      details.append(node('strong', chat.title), node('small', chat.type));
      label.append(check, details);
      item.append(label);
      return item;
    });
    byId('schedule-chats').replaceChildren(...(items.length ? items :
      [node('li', query ? 'Чаты не найдены.' : 'Список чатов пуст.', 'empty')]));
    renderSelection();
  }

  function renderPlan() {
    const max = files.length ? limits.caption : limits.text;
    text.maxLength = max;
    byId('schedule-text-limit').textContent = `${text.value.length} / ${max}`;
    const items = files.map(file => {
      const item = node('li', '', 'schedule-file');
      const name = node('span', file.name);
      const remove = button('Убрать', async () => {
        await mini.files.releaseMany([file.id]);
        files = files.filter(current => current !== file);
        renderPlan();
      });
      remove.setAttribute('aria-label', 'Убрать ' + file.name);
      item.append(name, remove);
      return item;
    });
    byId('schedule-files').replaceChildren(...items);
    renderSelection();
  }

  async function loadChats(force = false) {
    status('Загружаем чаты…');
    chats = await client.scheduleChats(force);
    const available = new Set(chats.map(chat => chat.id));
    for (const id of selected) if (!available.has(id)) selected.delete(id);
    renderChats();
    status('');
  }

  async function pickFiles() {
    const picked = await mini.files.pickMultiple();
    const rejected = [];
    for (const file of picked ?? []) {
      if (files.length >= limits.files || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > limits.bytes) {
        rejected.push(file.id);
      } else files.push(file);
    }
    renderPlan();
    if (rejected.length) {
      await mini.files.releaseMany(rejected);
      status('Можно прикрепить до 10 непустых файлов размером до 2 ГБ каждый.', true);
    }
  }

  async function readFile(file, offset, length) {
    const chunk = await mini.files.readChunk(file.id, { offset, length, sequential: true });
    const bytes = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(chunk.data) : atob(chunk.data);
    if (chunk.offset !== offset || bytes.length !== length || (chunk.eof && offset + length < file.size)) {
      throw new Error('SCHEDULE_FILE_INCOMPLETE');
    }
    if (typeof bytes !== 'string') return bytes;
    const decoded = new Uint8Array(length);
    for (let index = 0; index < length; index++) decoded[index] = bytes.charCodeAt(index);
    return decoded;
  }

  async function releaseFiles() {
    const ids = files.map(file => file.id);
    files = [];
    if (ids.length) await mini.files.releaseMany(ids).catch(() => {});
  }

  async function resetDraft() {
    await releaseFiles();
    selected.clear();
    outcomes.clear();
    text.value = '';
    newDraft.hidden = true;
    results.replaceChildren();
    results.hidden = true;
    setDefaultWhen();
    renderPlan();
    renderChats();
  }

  function renderOutcomes(deliveries = outcomes.values()) {
    const items = [...deliveries].sort((a, b) => a.date - b.date).map(outcome => {
      const item = node('li');
      let detail = 'Ожидает новой попытки.';
      if (outcome.state === 'scheduled') detail = 'Запланировано.';
      else if (outcome.state === 'uncertain') detail = 'Telegram не подтвердил результат. Проверьте очередь.';
      else if (outcome.state === 'failed') detail = describe(new Error(outcome.code));
      item.append(node('strong', time.format(outcome.date * 1000) + ' · ' + outcome.title), node('p', detail));
      return item;
    });
    results.replaceChildren(...items);
    results.hidden = false;
  }

  async function submitPlan() {
    if (!selected.size) throw new Error('SCHEDULE_CHAT_COUNT');
    if ((!text.value.trim() && !files.length) || text.value.length > text.maxLength) {
      throw new Error('SCHEDULE_TEXT_LIMIT');
    }
    const days = selectedDays();
    if (new Set(days).size !== days.length) throw new Error('SCHEDULE_DUPLICATE_DAY');
    const dates = days.map(scheduleDate).sort((a, b) => a - b);
    if (dates.some(date => !Number.isSafeInteger(date))) throw new Error('SCHEDULE_INVALID_DAY');
    const deliveries = pendingDeliveries(dates);
    if (!deliveries.length) throw new Error('SCHEDULE_NO_PENDING');
    if (deliveries.length > limits.deliveries) throw new Error('SCHEDULE_DELIVERY_LIMIT');
    if (deliveries[0].date * 1000 - Date.now() < limits.leadSeconds * 1000) {
      throw new Error('SCHEDULE_LEAD_TIME');
    }
    const titles = new Map(chats.map(chat => [chat.id, chat.title]));
    const byDate = new Map();
    for (const { chatId, date } of deliveries) {
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(titles.get(chatId));
    }
    if (!await mini.ui.confirm({
      title: 'Запланировать отправку?',
      message: [...byDate].map(([date, names]) => time.format(date * 1000) + ' · ' + names.join(', ')).join('\n')
    })) return;
    for (const delivery of deliveries) {
      const key = deliveryKey(delivery.chatId, delivery.date);
      outcomes.set(key, { ...delivery, title: titles.get(delivery.chatId) });
    }
    function record(outcome) {
      const key = deliveryKey(outcome.chatId, outcome.date);
      outcomes.set(key, { ...outcome, title: titles.get(outcome.chatId) });
    }
    let response;
    try {
      response = await client.createScheduledBatch({
        deliveries,
        text: text.value,
        files: files.map(file => ({ ...file, readRange: (offset, length) => readFile(file, offset, length) })),
        onOutcome: record,
        onProgress: (stage, index, total) => status(stage === 'upload'
          ? `Загружаем файл ${index} из ${total}…`
          : `Планируем отправку ${index} из ${total}…`)
      });
    } catch (error) {
      newDraft.hidden = false;
      renderOutcomes();
      renderPlan();
      throw error;
    }
    response.forEach(record);
    const batchResults = [...outcomes.values()];
    const confirmed = response.filter(outcome => outcome.state === 'scheduled').length;
    if (confirmed === deliveries.length) await resetDraft();
    else {
      for (const chatId of selected) if (dates.every(date => deliveryDone(chatId, date))) selected.delete(chatId);
      newDraft.hidden = false;
      renderPlan();
      renderChats();
    }
    renderOutcomes(batchResults);
    status(`Запланировано ${confirmed} из ${deliveries.length} отправок.`, confirmed !== deliveries.length);
  }

  function renderQueue() {
    if (!client || !limits) return;
    const list = byId('schedule-queue-list');
    const rows = client.cachedScheduled();
    const panels = rows.map(({ chat, messages }) => {
      const panel = node('section', '', 'schedule-panel');
      const head = node('div', '', 'schedule-head');
      head.append(node('h3', chat.title), button('Отменить в чате', () => cancel(chat.id), 'danger'));
      const items = node('ul');
      for (const message of messages) {
        const item = node('li', '', 'schedule-message');
        const content = node('div');
        content.append(node('small', message.date === 2147483646 ? 'Когда собеседник будет онлайн' : time.format(message.date * 1000)));
        if (message.text) content.append(node('p', message.text, 'schedule-message-text'));
        if (message.files.length) content.append(node('p', message.files.join(', ')));
        if (!message.text && !message.files.length) content.append(node('p', 'Сообщение'));
        const action = button('Отменить', () => cancel(chat.id, message.ids), 'danger');
        action.setAttribute('aria-label', `Отменить сообщение в чате «${chat.title}»`);
        item.append(content, action);
        items.append(item);
      }
      panel.append(head, items);
      return panel;
    });
    list.replaceChildren(...panels);
    const { failures = [], remaining = 0, interrupted = false } = summary ?? {};
    const count = rows.reduce((total, row) => total + row.messages.length, 0);
    const totalText = count ? `В очереди: ${count} · Чатов: ${rows.length}` : 'Отложенных сообщений в проверенных чатах нет.';
    byId('schedule-summary').textContent = !summary ? 'Проверяем очередь…' :
      totalText + (interrupted ? ' Проверка прервана. Показаны данные из кэша.' :
        failures.length || remaining ? ` Недоступно: ${failures.length} · Осталось проверить: ${remaining}.` : '');
    const issues = byId('schedule-issues');
    issues.hidden = !failures.length;
    issues.querySelector('ul').replaceChildren(...failures.map(({ chat, code }) =>
      node('li', chat.title + ' · ' + describe(new Error(code)))));
  }

  async function checkQueue(force) {
    scan = new AbortController();
    stop.hidden = false;
    stop.disabled = false;
    try {
      summary = await client.scanScheduled({
        force, signal: scan.signal,
        onProgress: (index, count) => status(`Проверяем очередь: чат ${index} из ${count}…`)
      });
      status('');
      return summary;
    } catch (error) {
      summary = { interrupted: true };
      if (!scan.signal.aborted) throw error;
      status('Проверка остановлена. Показаны очереди из кэша.');
    } finally {
      scan = undefined;
      stop.hidden = true;
      renderQueue();
    }
  }

  async function cancel(chatId, ids) {
    let targets;
    let unavailable = 0;
    if (ids) targets = [{ chatId, ids }];
    else if (chatId) {
      const messages = await client.scheduledInChat(chatId, true);
      targets = [{ chatId, ids: messages.flatMap(message => message.ids) }];
    } else {
      status('Проверяем очереди перед отменой…');
      const current = await checkQueue(true);
      if (!current) return;
      unavailable = current.failures.length + current.remaining;
      targets = current.rows.map(row => ({ chatId: row.chat.id, ids: row.messages.flatMap(message => message.ids) }));
    }
    const count = targets.reduce((total, target) => total + target.ids.length, 0);
    if (!count) {
      status(unavailable ? 'В проверенных чатах очередь пуста. Часть чатов осталась непроверенной.' : 'Очередь уже пуста.');
      renderQueue();
      return;
    }
    if (!await mini.ui.confirm({
      title: ids ? 'Отменить отправку?' : chatId ? 'Очистить очередь чата?' : 'Очистить все проверенные очереди?',
      message: `Telegram удалит из очереди ${count} элементов. Файлы в группе учитываются отдельно.` +
        (unavailable ? ` Непроверенных чатов: ${unavailable}.` : '')
    })) {
      status('');
      return;
    }
    let removed = 0;
    let failure;
    for (const [index, target] of targets.entries()) {
      status(`Отменяем отправку: чат ${index + 1} из ${targets.length}…`);
      try {
        removed += await client.cancelScheduled(target.chatId, target.ids);
      } catch (error) {
        if (error?.code === 401) throw error;
        failure = describe(error);
        break;
      }
    }
    renderQueue();
    status(`Подтверждена отмена ${removed} из ${count} элементов.` +
      (removed < count ? ' Обновите очередь, чтобы проверить остальные.' : '') +
      (unavailable ? ` Непроверенных чатов: ${unavailable}.` : '') + (failure ? ' ' + failure : ''),
    Boolean(removed < count || unavailable));
  }

  navigation.addEventListener('click', event => {
    const next = event.target.closest('button')?.dataset.view;
    if (next) run(() => open(next));
  });
  plan.addEventListener('submit', event => {
    event.preventDefault();
    run(submitPlan);
  });
  search.addEventListener('input', renderChats);
  sendTime.addEventListener('input', renderSelection);
  addDayButton.addEventListener('click', addDay);
  newDraft.addEventListener('click', () => run(async () => {
    await resetDraft();
    results.replaceChildren();
    results.hidden = true;
  }));
  text.addEventListener('input', () => {
    byId('schedule-text-limit').textContent = `${text.value.length} / ${text.maxLength}`;
  });
  byId('schedule-pick').addEventListener('click', () => run(pickFiles));
  byId('schedule-refresh-chats').addEventListener('click', () => run(() => loadChats(true)));
  byId('schedule-refresh-queue').addEventListener('click', () => run(() => checkQueue(true)));
  byId('schedule-cancel-all').addEventListener('click', () => run(() => cancel()));
  stop.addEventListener('click', () => {
    scan?.abort();
    stop.disabled = true;
  });

  async function clearDraft() {
    selected.clear();
    outcomes.clear();
    text.value = sendTime.value = search.value = '';
    dayRows.replaceChildren();
    newDraft.hidden = true;
    results.replaceChildren();
    results.hidden = true;
    byId('schedule-files').replaceChildren();
    await releaseFiles();
  }

  return {
    async connect(current, settings, accountKey) {
      if (account !== accountKey || !accountKey) await clearDraft();
      account = accountKey;
      client = current;
      limits = settings;
      navigation.hidden = false;
      setView('chats');
    },
    async disconnect({ keepDraft = false } = {}) {
      scan?.abort();
      client = undefined;
      summary = undefined;
      chats = [];
      if (!keepDraft) {
        account = undefined;
        await clearDraft();
      }
      byId('schedule-chats').replaceChildren();
      byId('schedule-queue-list').replaceChildren();
      byId('schedule-issues').querySelector('ul').replaceChildren();
      setView('chats');
      byId('workspace').hidden = true;
      navigation.hidden = true;
    },
    setBusy,
    changed() {
      if (view === 'queue' && !busy) renderQueue();
    }
  };
}
