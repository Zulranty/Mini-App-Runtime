async originalPage => {
  const context = await originalPage.context().browser().newContext({ timezoneId: 'America/New_York' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2027-03-10T18:00:00Z'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const chats = [
      { id: '1', title: 'Семья', type: 'Группа' },
      { id: '2', title: 'Коллеги', type: 'Группа' },
      { id: '3', title: 'Архив', type: 'Личный чат' }
    ];
    const date = Math.floor(Date.now() / 1000) + 600;
    const message = (ids, text, files = []) => ({ ids, text, date, files });
    const state = window.scheduleFixture = {
      queue: [
        { chat: chats[0], messages: [message([7, 8], 'Альбом из Telegram', ['old.txt', 'photo.jpg']), message([9], 'Второе')] },
        { chat: chats[1], messages: [message([7], 'В другом чате')] }
      ],
      created: [], cancelled: [], confirms: [], released: [], reads: [], allow: true, forceScans: 0
    };
    let savedLogin = { apiId: 1, apiHash: 'fixture', session: 'fixture' };
    window.mini = {
      app: { getLaunchParams: async () => ({ reason: 'normal' }) },
      functions: { async call(method) {
        if (method === 'telegram.getSettings') return { testServer: false, writeLoginLog: false };
        if (method === 'telegram.getAppCredentials') return null;
        throw new Error('Unexpected native function: ' + method);
      } },
      modules: { load: async () => {} },
      events: { on: () => () => {} },
      permissions: { query: async () => 'granted' },
      secureStorage: { get: async () => savedLogin, remove: async () => { savedLogin = undefined; }, set: async (_, value) => { savedLogin = value; } },
      files: {
        pickMultiple: async () => [
          { id: 'handle-1', name: 'invoice.txt', size: 3, mimeType: 'text/plain' },
          { id: 'handle-2', name: 'second.txt', size: 3, mimeType: 'text/plain' }
        ],
        readChunk: async (id, { offset, length, sequential }) => {
          state.reads.push({ id, offset, length, sequential });
          return { offset, data: 'QUJD', eof: true };
        },
        releaseMany: async ids => state.released.push(...ids)
      },
      ui: { confirm: async options => { state.confirms.push(options); return state.allow; } }
    };
    window.MiniAppTelegram = {
      version: 1, phoneLoginVersion: 2, protectsSession: true, supportsQrLogin: true, reportsScheduleOutcomes: true,
      scheduleLimits: { chats: 10, deliveries: 30, files: 10, bytes: 2_000_000_000, text: 4096, caption: 1024, leadSeconds: 45 },
      createClient: () => ({
        resume: async () => 'Тест',
        accountId: () => '42',
        signIn: async () => 'Тест', session: () => 'renewed',
        loadUnconfirmedAuthorizations: async () => [],
        chats: async () => ({ items: chats, more: false }),
        scheduleChats: async () => chats,
        async createScheduledBatch({ deliveries, text, files, onOutcome }) {
          for (const file of files) {
            const data = await file.readRange(0, file.size);
            if (String(data) !== '65,66,67') throw new Error('File bytes changed');
          }
          state.created.push({ deliveries, text, names: files.map(file => file.name) });
          if (state.failAuth) {
            state.failAuth = false;
            onOutcome({ ...deliveries[0], state: 'scheduled' });
            onOutcome({ ...deliveries[1], state: 'failed', code: 'SESSION_EXPIRED' });
            throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { code: 401 });
          }
          return deliveries.map((delivery, index) => state.created.length === 1 && index === 2
            ? { ...delivery, state: 'failed', code: 'SCHEDULE_TOO_MUCH' }
            : { ...delivery, state: 'scheduled' });
        },
        cachedScheduled: () => state.queue,
        scanScheduled: async ({ force }) => {
          if (force) state.forceScans++;
          return { rows: state.queue, failures: [], remaining: 0 };
        },
        scheduledInChat: async id => state.queue.find(row => row.chat.id === id)?.messages ?? [],
        cancelScheduled: async (id, ids) => {
          state.cancelled.push({ id, ids });
          const row = state.queue.find(row => row.chat.id === id);
          row.messages = row.messages.filter(message => !message.ids.some(key => ids.includes(key)));
          state.queue = state.queue.filter(row => row.messages.length);
          return ids.length;
        },
        close: async () => {}
      })
    };
  });
  await page.goto(originalPage.url());
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.locator('#workspace-nav').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByLabel('Поиск по чатам').fill('кол');
  await page.getByRole('checkbox', { name: 'Коллеги Группа' }).check();
  await page.getByLabel('Поиск по чатам').fill('');
  await page.getByRole('checkbox', { name: 'Семья Группа' }).check();
  await page.getByLabel('Текст', { exact: true }).fill('Завтра встречаемся');
  await page.getByLabel('Время отправки').fill('02:30');
  await page.getByLabel('День 1', { exact: true }).fill('2027-03-14');
  await page.locator('#schedule-plan').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByText('Проверьте даты и местное время отправки для каждого дня.').waitFor();
  await page.getByLabel('Время отправки').fill('10:30');
  const days = await page.evaluate(() => [2, 5].map(offset => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map(value => String(value).padStart(2, '0')).join('-');
  }));
  await page.getByLabel('День 1', { exact: true }).fill(days[0]);
  await page.getByRole('button', { name: 'Добавить день' }).click();
  await page.getByLabel('День 2', { exact: true }).fill(days[0]);
  await page.locator('#schedule-plan').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByText('Один день указан несколько раз. Уберите повторяющиеся даты.').waitFor();
  if (await page.evaluate(() => window.scheduleFixture.confirms.length)) throw new Error('Duplicate days reached confirmation');
  await page.getByLabel('День 2', { exact: true }).fill(days[1]);
  await page.getByText('Отправок: 4 из 30').waitFor();
  await page.getByRole('button', { name: 'Прикрепить файлы' }).click();
  await page.getByText('invoice.txt', { exact: true }).waitFor();
  if (await page.locator('#schedule-text').getAttribute('maxlength') !== '1024') throw new Error('Caption limit missing');
  await page.locator('#schedule-plan').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByText('Запланировано 3 из 4 отправок.').waitFor();
  if (await page.getByRole('checkbox', { name: 'Семья Группа' }).isChecked()) throw new Error('Confirmed recipient can be duplicated');
  if (!await page.getByRole('checkbox', { name: 'Коллеги Группа' }).isChecked()) throw new Error('Failed recipient was lost');
  const { submitted, expected, confirmation } = await page.evaluate(dates => ({
    submitted: window.scheduleFixture.created[0],
    expected: dates.flatMap(day => ['2', '1'].map(chatId => ({
      chatId, date: new Date(day + 'T10:30').getTime() / 1000
    }))),
    confirmation: window.scheduleFixture.confirms[0].message
  }), days);
  if (JSON.stringify(submitted.deliveries) !== JSON.stringify(expected) ||
      submitted.deliveries[2].date - submitted.deliveries[0].date !== 71 * 3600 ||
      submitted.names.join(',') !== 'invoice.txt,second.txt' || submitted.text !== 'Завтра встречаемся' ||
      confirmation.split('\n').length !== 2 || !confirmation.split('\n').every(line => line.includes('10:30'))) {
    throw new Error('Unexpected schedule payload');
  }
  if (await page.locator('#schedule-results li').count() !== 4) throw new Error('Results do not identify each delivery');
  await page.getByRole('button', { name: 'Убрать invoice.txt' }).click();
  if (!await page.evaluate(() => window.scheduleFixture.released.includes('handle-1'))) throw new Error('File handle was retained');
  await page.getByText('Отправок: 1 из 30').waitFor();
  await page.locator('#schedule-plan').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByText('Запланировано 1 из 1 отправок.').waitFor();
  const retry = await page.evaluate(() => window.scheduleFixture.created[1]);
  if (JSON.stringify(retry.deliveries) !== JSON.stringify([expected[2]]) ||
      await page.locator('#schedule-results li').count() !== 4) throw new Error('Retry duplicated an acknowledged delivery');

  await page.locator('#workspace-nav').getByRole('button', { name: 'Отложенные' }).click();
  await page.getByText('В очереди: 3 · Чатов: 2').waitFor();
  const album = page.locator('.schedule-message').filter({ hasText: 'Альбом из Telegram' });
  await page.evaluate(() => { window.scheduleFixture.allow = false; });
  await album.getByRole('button').click();
  await page.waitForFunction(() => window.scheduleFixture.confirms.length === 3);
  if (await page.evaluate(() => window.scheduleFixture.cancelled.length)) throw new Error('Declined cancellation mutated Telegram');
  await page.evaluate(() => { window.scheduleFixture.allow = true; });
  await album.getByRole('button').click();
  await page.getByText('В очереди: 2 · Чатов: 2').waitFor();
  await page.locator('#schedule-queue-list section').filter({ has: page.getByRole('heading', { name: 'Семья' }) })
    .getByRole('button', { name: 'Отменить в чате' }).click();
  await page.getByText('В очереди: 1 · Чатов: 1').waitFor();
  await page.getByRole('button', { name: 'Отменить всё' }).click();
  await page.getByText('Подтверждена отмена 1 из 1 элементов.').waitFor();
  const { cancelled, forceScans } = await page.evaluate(() => window.scheduleFixture);
  if (JSON.stringify(cancelled) !== JSON.stringify([
    { id: '1', ids: [7, 8] }, { id: '1', ids: [9] }, { id: '2', ids: [7] }
  ]) || forceScans !== 1) throw new Error('Cancellation scopes changed');

  await page.locator('#workspace-nav').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByRole('checkbox', { name: 'Коллеги Группа' }).check();
  await page.getByRole('checkbox', { name: 'Семья Группа' }).check();
  await page.getByLabel('Текст', { exact: true }).fill('Черновик после повторного входа');
  await page.evaluate(() => { window.scheduleFixture.failAuth = true; });
  await page.locator('#schedule-plan').getByRole('button', { name: 'Запланировать' }).click();
  await page.locator('#status').filter({ hasText: 'Сеанс завершён. Войдите снова.' }).waitFor();
  await page.locator('#login [name=apiId]').fill('12345');
  await page.locator('#login [name=apiHash]').fill('0123456789abcdef0123456789abcdef');
  await page.locator('#login [name=phone]').fill('+12345678900');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.locator('#workspace-nav').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByText('Отправок: 1 из 30').waitFor();
  if (await page.locator('#schedule-text').inputValue() !== 'Черновик после повторного входа')
    throw new Error('Reauthentication lost the draft');
  await page.locator('#schedule-plan').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByText('Запланировано 1 из 1 отправок.').waitFor();
  const attempts = await page.evaluate(() => window.scheduleFixture.created.slice(-2));
  if (JSON.stringify(attempts[1].deliveries) !== JSON.stringify(attempts[0].deliveries.slice(1)))
    throw new Error('Reauthentication duplicated an acknowledged delivery');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#workspace-nav').getByRole('button', { name: 'Запланировать' }).click();
  await page.getByText('Выбрано 0 из 10').waitFor();
  await page.getByRole('button', { name: 'Добавить день' }).click();
  await page.getByLabel('День 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Убрать день 2' }).click();
  if (await page.getByLabel('День 2', { exact: true }).count()) throw new Error('Date row could not be removed');
  const mobile = await page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= innerWidth,
    panels: getComputedStyle(document.getElementById('schedule-plan')).gridTemplateColumns.split(' ').length
  }));
  if (!mobile.fits || mobile.panels !== 1 || errors.length) throw new Error(JSON.stringify({ mobile, errors }));
  await context.close();
  return 'Scheduled Telegram browser smoke passed, including DST, partial retry and reauthentication';
}
