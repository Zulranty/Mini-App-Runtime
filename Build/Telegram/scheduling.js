import { Api, helpers, utils } from 'teleproto';

export const scheduleLimits = Object.freeze({
  chats: 10, deliveries: 30, files: 10, bytes: 2_000_000_000, text: 4096, caption: 1024, leadSeconds: 45
});
const unavailableScheduleChat = new Set([
  'SCHEDULE_TOO_MUCH', 'CHAT_WRITE_FORBIDDEN', 'CHAT_SEND_DOCS_FORBIDDEN', 'CHAT_ADMIN_REQUIRED', 'CHANNEL_PRIVATE'
]);

function scheduledHash(messages) {
  let hash = 0n;
  for (const { id, editDate, date } of messages) {
    for (const value of [id, editDate ?? 0, date]) {
      hash ^= hash >> 21n;
      hash = BigInt.asUintN(64, hash ^ (hash << 35n));
      hash ^= hash >> 4n;
      hash = BigInt.asUintN(64, hash + BigInt(value));
    }
  }
  return helpers.returnBigInt(BigInt.asIntN(64, hash));
}

function scheduledGroups(messages) {
  const groups = new Map();
  for (const message of messages) {
    const key = message.groupedId ? 'album:' + message.groupedId : 'message:' + message.id;
    let group = groups.get(key);
    if (!group) {
      group = { ids: [], date: message.date, text: '', files: [] };
      groups.set(key, group);
    }
    group.ids.push(message.id);
    if (message.message && !group.text) group.text = message.message;
    if (message.media && !(message.media instanceof Api.MessageMediaWebPage)) {
      const name = message.media.document?.attributes?.find(attr => attr instanceof Api.DocumentAttributeFilename)?.fileName;
      group.files.push(name || (message.media instanceof Api.MessageMediaPhoto ? 'Фото' : 'Вложение'));
    }
  }
  return [...groups.values()].sort((a, b) => a.date - b.date);
}

function rpcUpdates(result) {
  return result instanceof Api.UpdateShort ? [result.update] : result?.updates ?? [];
}

export function createScheduler({
  client, lifetimeSignal, sleep, largeUploadThreshold, currentAccountId, waitDeadline, onScheduledChange
}) {
  let scheduleDialogs;
  let scheduleDialogsUntil = 0;
  let nextScheduledRead = 0;
  let nextScheduledWrite = 0;
  let schedulingBlocked;
  const scheduledCache = new Map();

  function updateScheduled(chatId, update) {
    const entry = scheduledCache.get(chatId);
    if (!entry) return;
    const messages = entry.messages ?? [];
    entry.version++;
    entry.until = 0;
    if (update instanceof Api.UpdateNewScheduledMessage && update.message instanceof Api.Message) {
      entry.messages = messages.filter(message => message.id !== update.message.id).concat(update.message);
    } else if (update instanceof Api.UpdateDeleteScheduledMessages) {
      const removed = new Set(update.messages);
      entry.messages = messages.filter(message => !removed.has(message.id));
    }
    onScheduledChange?.(chatId);
  }

  async function scheduleChats(force = false, signal) {
    if (scheduleDialogs && !force && Date.now() < scheduleDialogsUntil) {
      return [...scheduleDialogs.values()].map(record => record.chat);
    }
    const records = new Map();
    const accountId = currentAccountId();
    if (accountId) {
      records.set(accountId, {
        peer: new Api.InputPeerSelf(), chat: { id: accountId, title: 'Избранное', type: 'Личный чат' }
      });
    }
    for (const archived of [false, true]) {
      for await (const dialog of client.iterDialogs({ archived, ignoreMigrated: true })) {
        if (signal?.aborted || lifetimeSignal.aborted) throw new Error('operation_cancelled');
        const { entity, inputEntity } = dialog;
        const id = String(dialog.id);
        if (!inputEntity || records.has(id) || id === '777000') continue;
        const user = entity instanceof Api.User && !entity.deleted;
        const group = entity instanceof Api.Chat && !entity.left && !entity.deactivated;
        const channel = entity instanceof Api.Channel && !entity.left &&
          (!entity.broadcast || entity.creator || entity.adminRights?.postMessages);
        if (!user && !group && !channel) continue;
        const type = user ? 'Личный чат' : entity.broadcast ? 'Канал' : 'Группа';
        records.set(id, { peer: inputEntity, chat: { id, title: dialog.title || type, type } });
      }
    }
    scheduleDialogs = records;
    scheduleDialogsUntil = Date.now() + 120_000;
    for (const id of scheduledCache.keys()) if (!records.has(id)) scheduledCache.delete(id);
    return [...records.values()].map(record => record.chat);
  }

  function schedulePeer(chatId) {
    const record = scheduleDialogs?.get(chatId);
    if (!record) throw new Error('CHAT_NOT_LOADED');
    return record.peer;
  }

  async function invokeScheduled(request, write, options) {
    const signal = options.abortSignal;
    const delay = (write ? nextScheduledWrite : nextScheduledRead) - Date.now();
    if (delay > 0) await sleep(delay, lifetimeSignal, signal);
    else if (signal?.aborted || lifetimeSignal.aborted) throw new Error('operation_cancelled');
    try {
      return await client.invoke(request, undefined, options);
    } finally {
      if (write) nextScheduledWrite = Date.now() + 1100;
      else nextScheduledRead = Date.now() + 350;
    }
  }

  async function scheduledInChat(chatId, force = false, signal) {
    const peer = schedulePeer(chatId);
    let entry = scheduledCache.get(chatId);
    if (!entry) {
      entry = { version: 0, until: 0 };
      scheduledCache.set(chatId, entry);
    }
    if (!force && Date.now() < entry.until) return scheduledGroups(entry.messages);
    const version = entry.version;
    const hash = entry.hashVersion === version ? entry.hash : helpers.returnBigInt(0);
    const result = await invokeScheduled(new Api.messages.GetScheduledHistory({ peer, hash }), false,
      { abortSignal: signal, timeout: 20_000, maxRetryCount: 0 });
    const unchanged = result instanceof Api.messages.MessagesNotModified;
    if (entry.version !== version) {
      // An update received during the request may be newer than the snapshot.
      // Retry once before publishing a complete result.
      const currentVersion = entry.version;
      const fresh = await invokeScheduled(new Api.messages.GetScheduledHistory({ peer, hash: helpers.returnBigInt(0) }),
        false, { abortSignal: signal, timeout: 20_000, maxRetryCount: 0 });
      if (entry.version !== currentVersion) throw new Error('SCHEDULE_QUEUE_CHANGED');
      return storeScheduled(entry, fresh.messages);
    }
    return storeScheduled(entry, unchanged ? entry.messages : result.messages);
  }

  function storeScheduled(entry, messages) {
    if (!Array.isArray(messages)) throw new Error('SCHEDULE_HISTORY_UNCONFIRMED');
    const complete = messages.filter(message => message instanceof Api.Message);
    entry.messages = complete;
    entry.hash = complete.length === messages.length ? scheduledHash(complete) : helpers.returnBigInt(0);
    entry.hashVersion = entry.version;
    entry.until = Date.now() + 60_000;
    return scheduledGroups(complete);
  }

  async function scanScheduled({ force = false, signal, onProgress } = {}) {
    const chats = await scheduleChats(force, signal);
    const rows = [];
    const failures = [];
    for (const [index, chat] of chats.entries()) {
      if (signal?.aborted) throw new Error('operation_cancelled');
      onProgress?.(index + 1, chats.length);
      try {
        const messages = await scheduledInChat(chat.id, force, signal);
        if (messages.length) rows.push({ chat, messages });
      } catch (error) {
        const code = error?.errorMessage || error?.message;
        if (signal?.aborted || error?.code === 401 || /^(PEER_FLOOD|FROZEN_METHOD_INVALID)$/.test(code)) throw error;
        failures.push({ chat, code });
        if (![400, 403, 404, 406].includes(error?.code) && code !== 'SCHEDULE_QUEUE_CHANGED') {
          return { rows, failures, remaining: chats.length - index - 1 };
        }
      }
    }
    return { rows, failures, remaining: 0 };
  }

  function cachedScheduled() {
    const rows = [];
    for (const [id, entry] of scheduledCache) {
      const chat = scheduleDialogs?.get(id)?.chat;
      if (chat && entry.messages?.length) rows.push({ chat, messages: scheduledGroups(entry.messages) });
    }
    return rows;
  }

  function checkScheduleDate(date, wait = 0) {
    const serverNow = client._sender?.serverNow?.() ?? Date.now() / 1000;
    if (!Number.isSafeInteger(date) || date >= 2147483647 ||
        date < serverNow + wait / 1000 + scheduleLimits.leadSeconds) throw new Error('SCHEDULE_LEAD_TIME');
  }

  async function scheduleUpload(file) {
    const uploaded = await client.uploadFile({
      file: { name: file.name, size: file.size, readRange: file.readRange, preferLargeParts: file.size >= largeUploadThreshold },
      workers: 1
    });
    const result = await client.invoke(new Api.messages.UploadMedia({
      peer: new Api.InputPeerSelf(),
      media: new Api.InputMediaUploadedDocument({
        file: uploaded, mimeType: file.mimeType || 'application/octet-stream', forceFile: true,
        attributes: [new Api.DocumentAttributeFilename({ fileName: file.name })]
      })
    }));
    if (!(result instanceof Api.MessageMediaDocument) || !(result.document instanceof Api.Document)) {
      throw new Error('SCHEDULE_UPLOAD_UNCONFIRMED');
    }
    return new Api.InputMediaDocument({ id: utils.getInputDocument(result.document) });
  }

  async function createScheduled({ chatIds, text, date, files, onProgress }) {
    if (!chatIds.length || chatIds.length > scheduleLimits.chats || new Set(chatIds).size !== chatIds.length) {
      throw new Error('SCHEDULE_CHAT_COUNT');
    }
    return createScheduledBatch({ deliveries: chatIds.map(chatId => ({ chatId, date })), text, files, onProgress });
  }

  async function createScheduledBatch({ deliveries, text, files, onProgress, onOutcome }) {
    if (schedulingBlocked) throw new Error(schedulingBlocked);
    if (!deliveries.length || deliveries.length > scheduleLimits.deliveries) throw new Error('SCHEDULE_DELIVERY_LIMIT');
    const peers = new Map();
    const datesByChat = new Map();
    for (const { chatId, date } of deliveries) {
      if (!Number.isSafeInteger(date) || date >= 2147483647 || date <= 0) throw new Error('SCHEDULE_INVALID_DAY');
      if (!peers.has(chatId)) {
        if (peers.size === scheduleLimits.chats) throw new Error('SCHEDULE_CHAT_COUNT');
        peers.set(chatId, schedulePeer(chatId));
        datesByChat.set(chatId, new Set());
      }
      const dates = datesByChat.get(chatId);
      if (dates.has(date)) throw new Error('SCHEDULE_DUPLICATE_DAY');
      dates.add(date);
    }
    const ordered = [...deliveries].sort((a, b) => a.date - b.date);
    if (files.length > scheduleLimits.files || files.some(file =>
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > scheduleLimits.bytes)) throw new Error('SCHEDULE_FILE_LIMIT');
    if (text.length > (files.length ? scheduleLimits.caption : scheduleLimits.text) || (!text.trim() && !files.length)) {
      throw new Error('SCHEDULE_TEXT_LIMIT');
    }
    checkScheduleDate(ordered[0].date, Math.max(0, waitDeadline() - Date.now()));
    const media = [];
    for (const [index, file] of files.entries()) {
      checkScheduleDate(ordered[ordered.length - 1].date, Math.max(0, waitDeadline() - Date.now()));
      onProgress?.('upload', index + 1, files.length);
      try {
        media.push(await scheduleUpload(file));
      } catch (error) {
        if (['PEER_FLOOD', 'FROZEN_METHOD_INVALID'].includes(error?.errorMessage)) schedulingBlocked = error.errorMessage;
        throw error;
      }
    }
    const outcomes = [];
    function record(outcome) {
      outcomes.push(outcome);
      onOutcome?.(outcome);
    }
    const failedChats = new Map();
    for (const [index, { chatId, date }] of ordered.entries()) {
      onProgress?.('schedule', index + 1, ordered.length);
      if (failedChats.has(chatId)) {
        record({ chatId, date, state: 'failed', code: failedChats.get(chatId) });
        continue;
      }
      const peer = peers.get(chatId);
      const fields = { peer, scheduleDate: date };
      const request = media.length > 1 ? new Api.messages.SendMultiMedia({
        ...fields, multiMedia: media.map((file, i) => new Api.InputSingleMedia({
          media: file, message: i === 0 ? text : '', randomId: helpers.generateRandomLong()
        }))
      }) : media.length ? new Api.messages.SendMedia({
        ...fields, media: media[0], message: text, randomId: helpers.generateRandomLong()
      }) : new Api.messages.SendMessage({ ...fields, message: text, randomId: helpers.generateRandomLong() });
      let dispatched = false;
      try {
        const result = await invokeScheduled(request, true, {
          abortSignal: lifetimeSignal, maxRetryCount: 0, timeout: 12_000,
          beforeSend: wait => {
            checkScheduleDate(date, wait);
            if (!wait) dispatched = true;
          }
        });
        const updates = rpcUpdates(result).filter(update => update instanceof Api.UpdateNewScheduledMessage &&
          update.message?.peerId && String(utils.getPeerId(update.message.peerId)) === chatId && update.message.date === date);
        if (new Set(updates.map(update => update.message.id)).size !== Math.max(1, media.length)) {
          throw new Error('SCHEDULE_SEND_UNCONFIRMED');
        }
        for (const update of updates) updateScheduled(chatId, update);
        record({ chatId, date, state: 'scheduled' });
      } catch (error) {
        if (error?.code === 401) {
          record({ chatId, date, state: 'failed', code: 'SESSION_EXPIRED' });
          throw error;
        }
        const code = error?.errorMessage || error?.message;
        const restricted = ['PEER_FLOOD', 'FROZEN_METHOD_INVALID'].includes(code);
        if (restricted) schedulingBlocked = code;
        const rejected = !dispatched || [400, 403, 404, 406, 420].includes(error?.code) || restricted ||
          code === 'SCHEDULE_LEAD_TIME';
        if (unavailableScheduleChat.has(code)) failedChats.set(chatId, code);
        record({ chatId, date, state: rejected ? 'failed' : 'uncertain', code });
        if (!rejected) {
          const entry = scheduledCache.get(chatId);
          if (entry) { entry.version++; entry.until = 0; }
        }
        const waitConflicts = code === 'SCHEDULE_LEAD_TIME' && waitDeadline() > Date.now();
        if (!rejected || restricted || waitConflicts || error?.code === 420 || lifetimeSignal.aborted) break;
      }
    }
    return outcomes;
  }

  async function cancelScheduled(chatId, ids) {
    const peer = schedulePeer(chatId);
    const removed = new Set();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const entry = scheduledCache.get(chatId);
      if (entry) { entry.version++; entry.until = 0; }
      const result = await invokeScheduled(new Api.messages.DeleteScheduledMessages({ peer, id: batch }), true,
        { abortSignal: lifetimeSignal, maxRetryCount: 0, timeout: 20_000 });
      for (const update of rpcUpdates(result)) {
        if (!(update instanceof Api.UpdateDeleteScheduledMessages) || String(utils.getPeerId(update.peer)) !== chatId) continue;
        updateScheduled(chatId, update);
        for (const [index, id] of update.messages.entries()) if (!update.sentMessages?.[index]) removed.add(id);
      }
    }
    return ids.filter(id => removed.has(id)).length;
  }

  return {
    update: updateScheduled,
    actions: Object.freeze({ scheduleChats, scheduledInChat, scanScheduled, cachedScheduled,
      createScheduled, createScheduledBatch, cancelScheduled })
  };
}
