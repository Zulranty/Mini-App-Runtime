'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const dependency = createRequire(path.resolve(__dirname, '../../Cache/Telegram/module/build-module.cjs'));
const { Api, TelegramClient } = dependency('teleproto');
const { buildSync } = dependency('esbuild');
const { outputFiles: [entry] } = buildSync({
  entryPoints: [path.join(__dirname, 'telegram.js')],
  bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false
});
const host = {
  window: {}, require: dependency, AbortController,
  setTimeout: (...args) => setTimeout(...args), clearTimeout: timer => clearTimeout(timer)
};
vm.runInNewContext(entry.text, host);

const prototype = TelegramClient.prototype;
prototype.connect = async () => {};
prototype.destroy = async () => {};
const library = host.window.MiniAppTelegram;
const credentials = { apiId: 99, apiHash: '0123456789abcdef0123456789abcdef' };
const makeError = code => Object.assign(new Error(code), { errorMessage: code });
const user = new Api.User({ id: 21, firstName: 'Fixture' });

async function withQr(t, requests, verify) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let handler;
  prototype.addEventHandler = callback => { handler = callback; };
  prototype.removeEventHandler = callback => {
    assert.equal(callback, handler);
    handler = undefined;
  };
  prototype.invoke = requests;
  const client = library.createClient(credentials);
  let displayed;
  const firstQr = new Promise(resolve => { displayed = resolve; });
  const shown = [];
  const prompts = [];
  const controller = new AbortController();
  const logs = [];
  const result = client.signInQr((matrix, expires) => {
    assert(matrix.length > 0);
    shown.push(expires);
    displayed();
  }, async (kind, hint) => {
    prompts.push({ kind, hint });
    return 'fixture-password';
  }, error => { throw error; }, controller.signal, (event, fields) => logs.push({ event, ...fields })).then(
    name => ({ name }),
    error => ({ error })
  );
  try {
    await firstQr;
    await new Promise(resolve => setImmediate(resolve));
    await verify({ result, shown, prompts, logs, update: () => handler?.(new Api.UpdateLoginToken()), controller });
    assert.equal(handler, undefined);
  } finally {
    controller.abort();
    await client.close();
  }
}

function token() {
  return new Api.auth.LoginToken({ token: Buffer.from([1, 2, 3, 4]), expires: Math.floor(Date.now() / 1000) + 1 });
}

test('QR renewal asks for 2FA after a scan even when the login update was missed', { timeout: 4000 }, async t => {
  let exports = 0;
  prototype.signInWithPassword = async (_, options) => {
    assert.equal(await options.password('fixture hint'), 'fixture-password');
    return user;
  };
  await withQr(t, async request => {
    assert(request instanceof Api.auth.ExportLoginToken);
    if (++exports === 1) return token();
    throw makeError('SESSION_PASSWORD_NEEDED');
  }, async ({ result, prompts }) => {
    t.mock.timers.tick(30_000);
    const outcome = await result;
    assert.ifError(outcome.error);
    assert.equal(outcome.name, 'Fixture');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].kind, 'password');
    assert.equal(prompts[0].hint, 'fixture hint');
  });
});

test('QR renewal completes an already confirmed login without a login update', { timeout: 4000 }, async t => {
  let exports = 0;
  await withQr(t, async request => {
    assert(request instanceof Api.auth.ExportLoginToken);
    if (++exports === 1) return token();
    return new Api.auth.LoginTokenSuccess({ authorization: new Api.auth.Authorization({ user }) });
  }, async ({ result, prompts }) => {
    t.mock.timers.tick(30_000);
    const outcome = await result;
    assert.ifError(outcome.error);
    assert.equal(outcome.name, 'Fixture');
    assert.equal(prompts.length, 0);
  });
});

test('QR switches data centers after a scan and requests the password there', { timeout: 4000 }, async t => {
  let exports = 0;
  let dc;
  prototype._switchDC = async id => { dc = id; };
  prototype.signInWithPassword = async (_, options) => {
    assert.equal(dc, 3);
    assert.equal(await options.password('migrated'), 'fixture-password');
    return user;
  };
  await withQr(t, async request => {
    if (request instanceof Api.auth.ExportLoginToken) {
      if (++exports === 1) return token();
      return new Api.auth.LoginTokenMigrateTo({ dcId: 3, token: Buffer.from([5]) });
    }
    assert(request instanceof Api.auth.ImportLoginToken);
    assert.equal(dc, 3);
    throw makeError('SESSION_PASSWORD_NEEDED');
  }, async ({ result, prompts, update, logs }) => {
    update();
    const outcome = await result;
    assert.ifError(outcome.error);
    assert.equal(outcome.name, 'Fixture');
    assert.equal(prompts[0].hint, 'migrated');
    assert(logs.some(entry => entry.event === 'auth.exportLoginToken.result' &&
      entry.result === 'migrate' && entry.targetDc === 3));
    assert(logs.some(entry => entry.event === 'auth.importLoginToken.error' && entry.code === 'SESSION_PASSWORD_NEEDED'));
    assert(logs.some(entry => entry.event === 'qr.password_required'));
    assert(logs.every(entry => !('token' in entry) && !('apiHash' in entry) && !('password' in entry)));
  });
});

test('QR checks for confirmation immediately when Android resumes and unsubscribes', { timeout: 4000 }, async t => {
  let resume;
  let exports = 0;
  host.window.mini = {
    functions: { call: async method => {
      if (method === "telegram.acquire") return 0;
      assert.equal(method, "telegram.release");
    } },
    events: { on(name, handler) {
      assert.equal(name, 'app.resume');
      resume = handler;
      return () => { resume = undefined; };
    } }
  };
  try {
    await withQr(t, async request => {
      assert(request instanceof Api.auth.ExportLoginToken);
      if (++exports === 1) return token();
      return new Api.auth.LoginTokenSuccess({ authorization: new Api.auth.Authorization({ user }) });
    }, async ({ result, logs }) => {
      resume();
      const outcome = await result;
      assert.ifError(outcome.error);
      assert.equal(outcome.name, 'Fixture');
      assert.equal(exports, 2);
      assert.equal(resume, undefined);
      assert(logs.some(entry => entry.event === 'qr.app_resumed'));
    });
  } finally {
    delete host.window.mini;
  }
});

test('QR cancellation removes the update handler and stops token renewal', { timeout: 4000 }, async t => {
  let exports = 0;
  await withQr(t, async () => {
    exports++;
    return token();
  }, async ({ result, controller }) => {
    controller.abort();
    assert((await result).error);
    t.mock.timers.tick(60_000);
    assert.equal(exports, 1);
  });
});

test('phone sign-in presents Telegram delivery and asks for 2FA after the code', async () => {
  prototype.getMe = async () => user;
  prototype.signInWithPassword = async (_, options) => {
    assert.equal(await options.password('phone password hint'), 'fixture-password');
    return user;
  };
  let sends = 0;
  prototype.invoke = async request => {
    if (request instanceof Api.updates.GetState) throw makeError('AUTH_KEY_UNREGISTERED');
    if (request instanceof Api.auth.SendCode) {
      assert.equal(++sends, 1);
      assert.equal(request.phoneNumber, '+12025550100');
      assert.equal(request.apiId, credentials.apiId);
      assert.equal(request.apiHash, credentials.apiHash);
      assert(request.settings instanceof Api.CodeSettings);
      assert.equal(Buffer.from(request.getBytes()).toString('hex'),
        '4f2477a60c2b313230323535353031303000000063000000203031323334353637383961626364656630313233343536373839616263646566000000783d25ad00000000');
      return new Api.auth.SentCode({
        type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: 'fixture-code',
        nextType: new Api.auth.CodeTypeSms(), timeout: 30
      });
    }
    assert(request instanceof Api.auth.SignIn);
    assert.equal(request.phoneNumber, '+12025550100');
    assert.equal(request.phoneCodeHash, 'fixture-code');
    assert.equal(request.phoneCode, '12345');
    throw makeError('SESSION_PASSWORD_NEEDED');
  };
  const client = library.createClient(credentials);
  const calls = [];
  try {
    const name = await client.signIn('+12025550100', async (kind, hint, delivery) => {
      calls.push(kind);
      if (kind === 'password') return 'fixture-password';
      assert.match(hint, /служебный чат/);
      assert.equal(delivery.type, 'app');
      assert.equal(delivery.nextType, 'sms');
      assert.equal(delivery.responseType, 'auth.SentCodeTypeApp');
      assert.equal(delivery.nextResponseType, 'auth.CodeTypeSms');
      assert.equal(delivery.timeout, 30);
      assert(!JSON.stringify(delivery).includes('fixture-code'));
      return '12345';
    }, error => { throw error; });
    assert.equal(name, 'Fixture');
    assert.deepEqual(calls, ['code', 'password']);
  } finally {
    await client.close();
  }
});

test('resend uses the original hash and cancelling after resend uses the new hash', async () => {
  const phoneNumber = '+12025550100';
  const requests = [];
  prototype.invoke = async request => {
    if (request instanceof Api.updates.GetState) throw makeError('AUTH_KEY_UNREGISTERED');
    requests.push(request.className);
    assert.equal(request.phoneNumber, phoneNumber);
    if (request instanceof Api.auth.SendCode) return new Api.auth.SentCode({
      type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: 'first',
      nextType: new Api.auth.CodeTypeSms(), timeout: 0
    });
    if (request instanceof Api.auth.ResendCode) {
      assert.equal(request.phoneCodeHash, 'first');
      return new Api.auth.SentCode({
        type: new Api.auth.SentCodeTypeSms({ length: 5 }), phoneCodeHash: 'second'
      });
    }
    assert(request instanceof Api.auth.CancelCode);
    assert.equal(request.phoneCodeHash, 'second');
    return true;
  };
  const client = library.createClient(credentials);
  try {
    await assert.rejects(client.signIn(phoneNumber, async (_, hint, delivery) => {
      if (delivery.type === 'app') return null;
      assert.equal(delivery.responseType, 'auth.SentCodeTypeSms');
      assert.equal(delivery.nextResponseType, undefined);
      assert.equal(delivery.timeout, undefined);
      throw new Error('AUTH_SWITCH_TO_QR');
    }, error => { throw error; }), /AUTH_SWITCH_TO_QR/);
    assert.deepEqual(requests, ['auth.SendCode', 'auth.ResendCode', 'auth.CancelCode']);
  } finally {
    await client.close();
  }
});

test('a Telegram response without next_type does not authorize a resend', async () => {
  prototype.invoke = async request => {
    if (request instanceof Api.updates.GetState) throw makeError('AUTH_KEY_UNREGISTERED');
    assert(request instanceof Api.auth.SendCode);
    return new Api.auth.SentCode({
      type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: 'fixture-code'
    });
  };
  const client = library.createClient(credentials);
  try {
    await assert.rejects(client.signIn('+12025550100', async (_, hint, delivery) => {
      assert.equal(delivery.nextType, undefined);
      return null;
    }, error => { throw error; }), /SEND_CODE_UNAVAILABLE/);
  } finally {
    await client.close();
  }
});

test('test login acquires a test lease and checks server configuration before sending a code', async t => {
  const calls = [];
  let testMode = false;
  host.window.mini = { functions: { async call(method) {
    if (method === 'telegram.acquireTest') {
      calls.push('test-lease');
      return 0;
    }
    assert.equal(method, 'telegram.release');
    calls.push('release');
  } } };
  t.mock.method(prototype, 'connect', async function() {
    assert.equal(this._testServers, true);
    assert.equal((await this.getDC(2)).ipAddress.length > 0, true);
    this._config = { testMode };
    calls.push('connect');
  });
  t.mock.method(prototype, 'invoke', async request => {
    assert(request instanceof Api.auth.SendCode);
    calls.push('sendCode');
    return new Api.auth.SentCodeSuccess({ authorization: new Api.auth.Authorization({ user }) });
  });
  t.mock.method(prototype, 'getMe', async () => user);
  try {
    const rejected = library.createClient({ ...credentials, testServers: true });
    try {
      await assert.rejects(rejected.signIn('+12025550100', assert.fail, assert.fail), /TELEGRAM_TEST_SERVER_MISMATCH/);
    } finally {
      await rejected.close();
    }
    assert.deepEqual(calls, ['test-lease', 'connect', 'release']);
    testMode = true;
    const accepted = library.createClient({ ...credentials, testServers: true });
    try {
      assert.equal(await accepted.signIn('+12025550100', assert.fail, assert.fail), 'Fixture');
    } finally {
      await accepted.close();
    }
    assert.deepEqual(calls.slice(3), ['test-lease', 'connect', 'sendCode', 'release']);
  } finally {
    delete host.window.mini;
  }
});

test('resend can switch to login email and successful responses provide future authorization tokens', async () => {
  const savedTokens = ['010203'];
  const issued = [];
  const logs = [];
  const requests = [];
  prototype.invoke = async request => {
    requests.push(request.className);
    if (request instanceof Api.auth.SendCode) {
      assert.equal(request.settings.logoutTokens[0].toString('hex'), savedTokens[0]);
      assert(request.getBytes().includes(Buffer.from(savedTokens[0], 'hex')));
      return new Api.auth.SentCode({ type: new Api.auth.SentCodeTypeApp({ length: 5 }),
        phoneCodeHash: 'app-hash', nextType: new Api.auth.CodeTypeSms(), timeout: 0 });
    }
    if (request instanceof Api.auth.ResendCode) {
      assert.equal(request.phoneCodeHash, 'app-hash');
      return new Api.auth.SentCode({ type: new Api.auth.SentCodeTypeEmailCode({ emailPattern: 'a***@example.test', length: 6 }),
        phoneCodeHash: 'email-hash' });
    }
    if (request instanceof Api.auth.LogOut) return new Api.auth.LoggedOut({ futureAuthToken: Buffer.from('d0e1f2', 'hex') });
    assert(request instanceof Api.auth.SignIn);
    assert.equal(request.phoneCodeHash, 'email-hash');
    assert.equal(request.phoneCode, undefined);
    assert.equal(request.emailVerification.code, '654321');
    return new Api.auth.Authorization({ user, futureAuthToken: Buffer.from('aabbcc', 'hex') });
  };
  const client = library.createClient({ ...credentials, onFutureAuthToken: token => issued.push(token) });
  try {
    assert.equal(await client.signIn('+12025550100', async (kind, hint) => {
      if (kind === 'code') return null;
      assert.equal(kind, 'emailCode');
      assert.equal(hint, 'a***@example.test');
      return '654321';
    }, error => { throw error; }, (...entry) => logs.push(entry), savedTokens), 'Fixture');
    assert.equal(await client.logout(), true);
    assert.deepEqual(issued, ['aabbcc', 'd0e1f2']);
    assert.deepEqual(requests, ['auth.SendCode', 'auth.ResendCode', 'auth.SignIn', 'auth.LogOut']);
    for (const value of [...savedTokens, ...issued, '654321', 'a***@example.test']) {
      assert(!JSON.stringify(logs).includes(value));
    }
  } finally {
    await client.close();
  }
});

test('email reset follows the latest challenge hash through email setup and phone confirmation', async () => {
  const prompts = [];
  prototype.invoke = async request => {
    if (request instanceof Api.auth.SendCode) return new Api.auth.SentCode({
      type: new Api.auth.SentCodeTypeEmailCode({ emailPattern: 'o***@example.test', length: 6, resetAvailablePeriod: 0 }),
      phoneCodeHash: 'old-email'
    });
    if (request instanceof Api.auth.ResetLoginEmail) {
      assert.equal(request.phoneCodeHash, 'old-email');
      return new Api.auth.SentCode({ type: new Api.auth.SentCodeTypeSetUpEmailRequired({}), phoneCodeHash: 'setup' });
    }
    if (request instanceof Api.account.SendVerifyEmailCode) {
      assert.equal(request.purpose.phoneCodeHash, 'setup');
      assert.equal(request.email, 'new@example.test');
      return new Api.account.SentEmailCode({ emailPattern: 'n***@example.test', length: 6 });
    }
    if (request instanceof Api.account.VerifyEmail) {
      assert.equal(request.purpose.phoneCodeHash, 'setup');
      assert.equal(request.verification.code, '246810');
      return new Api.account.EmailVerifiedLogin({ email: 'new@example.test', sentCode: new Api.auth.SentCode({
        type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: 'fresh-code'
      }) });
    }
    assert(request instanceof Api.auth.SignIn);
    assert.equal(request.phoneCodeHash, 'fresh-code');
    assert.equal(request.phoneCode, '54321');
    return new Api.auth.Authorization({ user });
  };
  const client = library.createClient(credentials);
  try {
    assert.equal(await client.signIn('+12025550100', async (kind, hint, delivery) => {
      prompts.push(kind);
      if (kind === 'email') return 'new@example.test';
      if (kind === 'code') return '54321';
      if (hint === 'o***@example.test') {
        assert(delivery.emailReset);
        return { resetLoginEmail: true };
      }
      assert.equal(hint, 'n***@example.test');
      return '246810';
    }, error => { throw error; }), 'Fixture');
    assert.deepEqual(prompts, ['emailCode', 'email', 'emailCode', 'code']);
  } finally {
    await client.close();
  }
});

test('a future token can require 2FA before any code prompt', async () => {
  prototype.invoke = async request => {
    assert(request instanceof Api.auth.SendCode);
    assert.equal(request.settings.logoutTokens[0].toString('hex'), '010203');
    throw makeError('SESSION_PASSWORD_NEEDED');
  };
  prototype.signInWithPassword = async (_, options) => {
    assert.equal(await options.password('test hint'), 'fixture-password');
    return user;
  };
  const client = library.createClient(credentials);
  try {
    assert.equal(await client.signIn('+12025550100', async (kind, hint) => {
      assert.equal(kind, 'password');
      assert.equal(hint, 'test hint');
      return 'fixture-password';
    }, error => { throw error; }, undefined, ['010203']), 'Fixture');
  } finally {
    await client.close();
  }
});

test('unconfirmed sessions can be accepted or revoked and visible service codes can be invalidated', async () => {
  let receiveUpdate;
  const notified = [];
  const requests = [];
  prototype.addEventHandler = callback => { receiveUpdate = callback; };
  prototype.invoke = async request => {
    requests.push(request);
    if (request instanceof Api.account.GetAuthorizations) return new Api.account.Authorizations({
      authorizationTtlDays: 180,
      authorizations: [{ hash: 30n, unconfirmed: true, deviceModel: 'Existing', country: 'Fixture' },
        { hash: 31n, unconfirmed: false }]
    });
    return true;
  };
  const client = library.createClient({ ...credentials, onNewAuthorization: device => notified.push(device) });
  try {
    await client.loadUnconfirmedAuthorizations();
    receiveUpdate(new Api.UpdateNewAuthorization({ hash: 33n, unconfirmed: true, device: 'New', location: 'Fixture' }));
    assert.deepEqual(JSON.parse(JSON.stringify(notified)), [
      { id: '30', device: 'Existing', location: 'Fixture' }, { id: '33', device: 'New', location: 'Fixture' }
    ]);
    await client.decideAuthorization('30', true);
    await client.decideAuthorization('33', false);
    await client.invalidateSignInCodes(['12345']);
    assert(requests[1] instanceof Api.account.ChangeAuthorizationSettings);
    assert.equal(String(requests[1].hash), '30');
    assert.equal(requests[1].confirmed, true);
    assert(requests[2] instanceof Api.account.ResetAuthorization);
    assert.equal(String(requests[2].hash), '33');
    assert(requests[3] instanceof Api.account.InvalidateSignInCodes);
    assert.equal(requests[3].codes[0], '12345');
  } finally {
    await client.close();
  }
});

test('phone login emits connection and RPC diagnostics without input or payload secrets', async () => {
  const phone = '+12025550100';
  const hash = 'private-phone-code-hash';
  const events = [];
  prototype.invoke = async function(request) {
    if (request instanceof Api.updates.GetState) throw makeError('AUTH_KEY_UNREGISTERED');
    if (request instanceof Api.auth.CancelCode) return true;
    assert(request instanceof Api.auth.SendCode);
    this.session.setDC(3, 'private-dc-address', 443);
    return new Api.auth.SentCode({
      type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: hash
    });
  };
  const client = library.createClient(credentials);
  try {
    await assert.rejects(client.signIn(phone, () => { throw new Error('AUTH_USER_CANCEL'); }, error => { throw error; },
      (event, fields) => events.push({ event, fields })), /AUTH_USER_CANCEL/);
    assert.deepEqual(events.map(item => item.event), [
      'connection.profile', 'session.wait', 'session.ready', 'connect.start', 'connect.result',
      'auth.sendCode.start', 'auth.sendCode.result', 'auth.cancelCode.start', 'auth.cancelCode.result'
    ]);
    const response = events[6].fields;
    assert.equal(response.dc, 3);
    assert.equal(response.response, 'auth.SentCode');
    assert.equal(response.type, 'auth.SentCodeTypeApp');
    assert.equal(response.next_type, undefined);
    assert.equal(response.timeout, undefined);
    const exported = JSON.stringify(events);
    for (const secret of [phone, hash, credentials.apiHash, 'private-dc-address'])
      assert(!exported.includes(secret));
  } finally {
    await client.close();
  }
});

test('phone sign-in serializes the configured OS and client version in initConnection', async t => {
  const initialized = [];
  t.mock.method(prototype, 'connect', async function() {
    const request = this._buildInitConnection(new Api.help.GetConfig());
    assert.equal(request.apiId, credentials.apiId);
    assert.equal(request.deviceModel, 'Mini App Runtime');
    assert.equal(request.langPack, '');
    initialized.push(request);
  });
  prototype.invoke = async request => {
    if (request instanceof Api.updates.GetState) throw makeError('AUTH_KEY_UNREGISTERED');
    assert(request instanceof Api.auth.SendCode);
    assert.equal(request.apiId, credentials.apiId);
    assert.equal(request.apiHash, credentials.apiHash);
    throw makeError('PHONE_NUMBER_FLOOD');
  };
  for (const systemVersion of ['Microsoft Windows NT 10.0.26100.0', 'Android 15']) {
    const profile = { appVersion: '1.4.4', systemVersion };
    const events = [];
    const client = library.createClient({ ...credentials, clientMetadata: profile });
    try {
      await assert.rejects(client.signIn('+12025550100', assert.fail, error => { throw error; },
        (event, fields) => events.push({ event, fields })), /PHONE_NUMBER_FLOOD/);
      const request = initialized.at(-1);
      assert.equal(request.appVersion, profile.appVersion);
      assert.equal(request.systemVersion, systemVersion);
      const wire = Buffer.from(request.getBytes());
      assert(wire.includes(Buffer.from(systemVersion)));
      assert(wire.includes(Buffer.from(profile.appVersion)));
      assert.equal(events[0].event, 'connection.profile');
      assert.equal(events[0].fields.systemVersion, systemVersion);
      assert.equal(events[0].fields.appVersion, profile.appVersion);
    } finally {
      await client.close();
    }
  }
  assert.equal(initialized.length, 2);
});

test('phone login logs RPC error codes while excluding raw error strings', async () => {
  const cases = [
    { errorMessage: 'PHONE_NUMBER_FLOOD', message: 'raw private error', expected: 'PHONE_NUMBER_FLOOD' },
    { errorMessage: 'RECAPTCHA_CHECK_private_token', message: 'raw private error', expected: 'RECAPTCHA_CHECK' },
    { errorMessage: 'SOME_PRIVATE_STRING', message: 'raw private error', expected: 'RPC_ERROR' }
  ];
  for (const { errorMessage, message, expected } of cases) {
    const error = Object.assign(new Error(message), { errorMessage, code: 400 });
    prototype.invoke = async request => {
      if (request instanceof Api.updates.GetState) throw makeError('AUTH_KEY_UNREGISTERED');
      assert(request instanceof Api.auth.SendCode);
      throw error;
    };
    const events = [];
    const client = library.createClient(credentials);
    try {
      await assert.rejects(client.signIn('+12025550100', assert.fail, failure => { throw failure; },
        (event, fields) => events.push({ event, fields })), error);
      const failure = events.find(item => item.event === 'auth.sendCode.error').fields;
      assert.equal(failure.code, expected);
      assert.equal(failure.rpcStatus, 400);
      assert(!JSON.stringify(events).includes(message));
      assert(!JSON.stringify(events).includes('private_token'));
      assert(!JSON.stringify(events).includes('SOME_PRIVATE_STRING'));
    } finally {
      await client.close();
    }
  }
});
