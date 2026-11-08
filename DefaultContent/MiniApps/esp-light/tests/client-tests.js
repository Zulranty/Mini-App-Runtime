'use strict';
const assert = require('node:assert/strict');
const { LightClient, validateInfo, validateState } = require('../client.js');
const { buildPoints, projectPoint, hitTest, hsvToHex, hexToHsv, palette } = require('../lamp-view.js');
const key = 'a'.repeat(32);
const info = { service: 'miniapp-light', version: 2, deviceId: key, name: 'Test-Light', ledCount: 6, effects: ['color','wheel','rainbow','fire','custom'], layout: { rows: 2, rowStarts: [0,3], rowLengths: [3,3], serpentine: true, radiusMm: 35, heightMm: 150 } };
const device = { id: 'handle-1', deviceId: key, name: 'Test-Light', service: 'miniapp-light' };
function fixture() {
  let state = { deviceId: key, on: false, brightness: 128, color: '#ff8844', effect: 'color', pixels: '000000'.repeat(6) };
  const writes = [], saved = new Map(), views = [], calls = [], requests = [];
  let permission = 'granted', list = [device], hold = null;
  const mini = {
    runtime: { supports: async () => true }, permissions: { query: async () => permission },
    storage: { get: async () => key, set: async (k, v) => saved.set(k, v) },
    network: {
      discoverDevices: async options => { calls.push(options); return list; },
      requestDevice: async options => {
        requests.push(options);
        assert.equal(Object.hasOwn(options, 'token'), false, 'No token in open-access requests');
        if (hold) { const gate = hold; hold = null; await gate; }
        if (options.path === '/api/info') return response(structuredClone(info));
        if (options.path === '/api/sync') return response({ deviceId: key, info: structuredClone(info), state: { ...state } });
        if (options.method === 'POST') {
          const form = new URLSearchParams(options.body); writes.push(options.body);
          if (form.has('on')) state.on = form.get('on') === '1';
          if (form.has('brightness')) state.brightness = Number(form.get('brightness'));
          if (form.has('color')) state.color = '#' + form.get('color');
          if (form.has('effect')) state.effect = form.get('effect');
          if (form.has('clear')) state.pixels = '000000'.repeat(6);
          if (form.has('index')) { const i = Number(form.get('index')) * 6; state.pixels = state.pixels.slice(0,i) + form.get('pixel') + state.pixels.slice(i+6); }
        }
        return response({ ...state });
      }
    }
  };
  function response(data) { return { status: 200, ok: true, body: { data: JSON.stringify(data) } }; }
  const client = new LightClient(mini, value => views.push(value));
  return { client, saved, writes, calls, views, requests, mini, setPermission: v => permission = v, setDevices: v => list = v, hold: p => hold = p };
}
async function run() {
  let n = 0;
  async function test(name, fn) { await fn(); console.log('PASS ' + name); n++; }
  await test('startup discovers and enables controls without secrets or pairing', async () => {
    const f = fixture();
    try { await f.client.start(); assert.equal(f.calls.length, 1); assert.equal(f.client.connection.state.on, false); assert.equal(f.requests.length, 2); assert.equal('secureStorage' in f.mini, false); assert.equal(f.client.pair, undefined); }
    finally { f.client.stop(); }
  });
  await test('no automatic discovery before permission', async () => {
    const f = fixture(); f.setPermission('prompt');
    try { assert.equal(await f.client.start(), false); assert.equal(f.calls.length, 0); }
    finally { f.client.stop(); }
  });
  await test('legacy authenticated firmware asks for update, never a key', async () => {
    const f = fixture(); const original = f.mini.network.requestDevice;
    f.mini.network.requestDevice = async options => options.path === '/api/state' ? { ok: false, status: 401, body: { data: '{}' } } : original(options);
    try { await f.client.start(); assert.equal(f.client.connection.state, null); assert.match(f.views.at(-1).message, /старая прошивка/); assert.equal(f.saved.size, 0); await assert.rejects(f.client.patch({ on: true }), { code: 'device_not_connected' }); }
    finally { f.client.stop(); }
  });
  await test('open access serializes power and brightness, preserves zero', async () => {
    const f = fixture();
    try {
      await f.client.start();
      await Promise.all([f.client.patch({ on: true }), f.client.patch({ brightness: 0 }), f.client.patch({ color: '#00aaff' })]);
      assert.deepEqual(f.writes, ['on=1', 'brightness=0', 'color=00aaff']);
      assert.equal(f.client.connection.state.brightness, 0); assert.equal(f.client.connection.state.on, true);
      assert.equal(f.saved.size, 0); assert.ok(f.requests.every(r => !Object.hasOwn(r, 'token')));
    } finally { f.client.stop(); }
  });
  await test('disconnected device can return with a new capability handle', async () => {
    const f = fixture();
    try {
      await f.client.start(); f.setDevices([]); await f.client.search(); assert.equal(f.client.connection, null);
      f.setDevices([{ ...device, id: 'handle-after-reboot' }]); await f.client.search();
      assert.equal(f.client.connection.device.id, 'handle-after-reboot'); assert.equal(f.client.connection.state.color, '#ff8844');
    } finally { f.client.stop(); }
  });
  await test('multiple unremembered devices require selection', async () => {
    const f = fixture(); f.mini.storage.get = async () => null;
    f.setDevices([device, { ...device, id: 'handle-2', deviceId: 'd'.repeat(32) }]);
    try { await f.client.start(); assert.equal(f.client.connection, null); assert.equal(f.client.devices.length, 2); await f.client.choose(device.id); assert.equal(f.client.connection.state.on, false); assert.equal(f.saved.get('deviceId'), key); }
    finally { f.client.stop(); }
  });
  await test('queued writes for old selection never reach another device', async () => {
    const f = fixture();
    try {
      await f.client.start(); let release; f.hold(new Promise(resolve => release = resolve));
      const first = f.client.patch({ on: true }); await new Promise(resolve => setImmediate(resolve));
      const second = f.client.patch({ brightness: 77 }); f.client.select(device.id); release();
      await Promise.all([first, second]); assert.deepEqual(f.writes, ['on=1']); assert.equal(f.client.connection.state, null);
    } finally { f.client.stop(); }
  });
  await test('paused/disposed session ignores an in-flight state reply', async () => {
    const f = fixture();
    try {
      await f.client.start(); let release; f.hold(new Promise(resolve => release = resolve));
      const task = f.client.patch({ on: true }); await new Promise(resolve => setImmediate(resolve));
      f.client.stop(); release(); await task; assert.equal(f.client.connection, null); assert.equal(f.client.timer, null);
    } finally { f.client.stop(); }
  });
  await test('malformed state response is rejected', async () => {
    const f = fixture();
    try {
      await f.client.start(); f.mini.network.requestDevice = async () => ({ ok: true, status: 200, body: { data: JSON.stringify({ deviceId: key, on: true, brightness: 256, color: '#ffffff', effect: 'color', pixels: '000000'.repeat(6) }) } });
      await assert.rejects(f.client.request(f.client.connection, '/api/state'), { code: 'protocol_mismatch' }); assert.equal(f.saved.size, 0);
    } finally { f.client.stop(); }
  });
  await test('older status poll cannot overwrite a newer command result', async () => {
    const f = fixture();
    try {
      await f.client.start(); const original = f.mini.network.requestDevice; let release; let entered;
      const started = new Promise(resolve => entered = resolve);
      f.mini.network.requestDevice = async options => {
        if (options.method !== 'GET') return original(options);
        const response = await original(options); entered();
        await new Promise(resolve => release = resolve); return response;
      };
      const poll = f.client.tick(); await started;
      await f.client.patch({ on: true }); release(); await poll;
      assert.equal(f.client.connection.state.on, true);
    } finally { f.client.stop(); }
  });
  await test('pixel writes preserve other LEDs and activate custom mode', async () => {
    const f=fixture();try { await f.client.start(); await f.client.setPixel(0,'#ff0000'); await f.client.setPixel(5,'#0000ff'); assert.equal(f.client.connection.state.effect,'custom'); assert.equal(f.client.connection.state.on,true); assert.equal(f.client.connection.state.pixels,'ff0000'+'000000'.repeat(4)+'0000ff'); await f.client.patch({clear:1}); assert.equal(f.client.connection.state.pixels,'000000'.repeat(6)); } finally {f.client.stop();}
  });
  await test('pixel bounds and invalid colors make no device writes',async()=>{
    const f=fixture();try {await f.client.start();for(const index of [-1,6,1.5])await assert.rejects(f.client.setPixel(index,'#ffffff'),{code:'invalid_pixel'});await assert.rejects(f.client.setPixel(0,'#fffffg'),{code:'invalid_pixel'});assert.equal(f.writes.length,0);}finally{f.client.stop();}
  });
  await test('sync reads authoritative device snapshot and serializes behind pending writes',async()=>{
    const f=fixture();try{await f.client.start();let release;f.hold(new Promise(resolve=>release=resolve));const write=f.client.patch({on:true});await new Promise(resolve=>setImmediate(resolve));const sync=f.client.sync();release();await Promise.all([write,sync]);assert.equal(f.requests.at(-1).path,'/api/sync');assert.equal(f.client.connection.state.on,true);assert.equal(f.views.at(-1).message,'Синхронизировано');}finally{f.client.stop();}
  });
  await test('sync loads settings changed by another controller, including layout and pixels',async()=>{
    const f=fixture();try{await f.client.start();const newer={...info,ledCount:2,layout:{...info.layout,rows:1,rowStarts:[0],rowLengths:[2]}};f.mini.network.requestDevice=async()=>({ok:true,status:200,body:{data:JSON.stringify({deviceId:key,info:newer,state:{deviceId:key,on:true,brightness:77,color:'#123456',effect:'custom',pixels:'ff00000000ff'}})}});await f.client.sync();assert.equal(f.client.connection.info.ledCount,2);assert.equal(f.client.connection.state.brightness,77);assert.equal(f.client.connection.state.pixels,'ff00000000ff');}finally{f.client.stop();}
  });
  await test('sync supersedes an older in-flight status poll',async()=>{
    const f=fixture();try{
      await f.client.start();const original=f.mini.network.requestDevice;let release,entered;const started=new Promise(resolve=>entered=resolve);let block=true;
      f.mini.network.requestDevice=async options=>{
        if(options.path==='/api/state'&&block){block=false;const old=await original(options);entered();await new Promise(resolve=>release=resolve);return old;}
        if(options.path==='/api/sync')return{ok:true,status:200,body:{data:JSON.stringify({deviceId:key,info,state:{deviceId:key,on:true,brightness:77,color:'#123456',effect:'fire',pixels:'000000'.repeat(6)}})}};
        return original(options);
      };
      const poll=f.client.tick();await started;await f.client.sync();release();await poll;assert.equal(f.client.connection.state.brightness,77);assert.equal(f.client.connection.state.effect,'fire');
    }finally{f.client.stop();}
  });
  await test('maximum512-LED snapshot and one-LED geometry are accepted',async()=>{
    const full={...info,ledCount:512,layout:{...info.layout,rows:1,rowStarts:[0],rowLengths:[512]}};validateInfo(full,key);assert.equal(buildPoints(full).length,512);validateState({deviceId:key,on:true,brightness:255,color:'#ffffff',effect:'custom',pixels:'ffffff'.repeat(512)},full);
    const one={...full,ledCount:1,layout:{...full.layout,rowLengths:[1]}};validateInfo(one,key);assert.equal(buildPoints(one)[0].index,0);
  });
  await test('invalid geometry and truncated pixel maps are rejected',async()=>{
    const broken=structuredClone(info);broken.layout.rowStarts[1]=2;assert.throws(()=>validateInfo(broken,key),{code:'protocol_mismatch'});
    const state={deviceId:key,on:true,brightness:128,color:'#ff0000',effect:'custom',pixels:'ff0000'};assert.throws(()=>validateState(state,info),{code:'protocol_mismatch'});
    state.pixels='000000'.repeat(6).slice(1)+'\n';assert.throws(()=>validateState(state,info),{code:'protocol_mismatch'});
    state.pixels='000000'.repeat(6);state.color='#ff0000\n';assert.throws(()=>validateState(state,info),{code:'protocol_mismatch'});
    assert.throws(()=>validateInfo({...info,version:1},key),{code:'firmware_update_required'});
  });
  await test('cylindrical geometry respects irregular rows and serpentine LED IDs',async()=>{
    const points=buildPoints(info);assert.equal(points.length,6);assert.deepEqual(points.slice(0,3).map(p=>p.index),[0,1,2]);assert.deepEqual(points.slice(3).map(p=>p.index),[5,4,3]);assert.equal(points[0].y,-75);assert.equal(points[3].y,75);assert.equal(points[0].z,35);
    const irregular={layout:{...info.layout,rows:2,rowStarts:[0,2],rowLengths:[2,1],serpentine:false}};assert.deepEqual(buildPoints(irregular).map(p=>p.index),[0,1,2]);
    const one={layout:{...info.layout,rows:1,rowStarts:[0],rowLengths:[1]}};assert.equal(buildPoints(one)[0].y,0);
  });
  await test('calibrated spiral column stays vertical and follows original physical LED IDs',async()=>{
    const calibrated={...info,ledCount:116,layout:{...info.layout,rows:15,columns:8,rowStarts:[0,8,16,23,31,39,46,54,62,69,77,85,92,100,108],rowLengths:[8,8,7,8,8,7,8,8,7,8,8,7,8,8,8],serpentine:false}};
    validateInfo(calibrated,key);
    const points=buildPoints(calibrated),stripe=[6,14,22,29,37,45,52,60,68,75,83,91,98,106,114].map(index=>points.find(p=>p.index===index));
    assert.equal(points.length,116);assert.deepEqual(points.map(p=>p.index).sort((a,b)=>a-b),Array.from({length:116},(_,i)=>i));
    assert.equal(stripe.length,15);
    for(const point of stripe){assert.ok(Math.abs(point.x+35)<1e-9);assert.ok(Math.abs(point.z)<1e-9);}
    assert.equal(new Set(stripe.map(p=>p.y)).size,15);
    assert.equal(points.find(p=>p.index===22).y,points.find(p=>p.index===16).y);
    assert.notEqual(points.find(p=>p.index===23).y,points.find(p=>p.index===22).y);
  });
  await test('invalid common column pitch rejects info before drawing',async()=>{
    for(const columns of [null,0,-1,2,3.5,513,'8'])assert.throws(()=>validateInfo({...info,layout:{...info.layout,columns}},key),{code:'protocol_mismatch'});
    validateInfo({...info,layout:{...info.layout,columns:3}},key);
    validateInfo(info,key); // Older HTTP v2 without columns keeps its geometry.
  });
  await test('physical LED coordinates override nominal rows and survive cylinder seam',async()=>{
    const physical={...info,layout:{...info.layout,anglesDeg:[0,90,180,270,360,45],heightsMm:[0,12.5,29,77,120,150]}};
    validateInfo(physical,key);const p=buildPoints(physical);
    assert.deepEqual(p.map(point=>point.index),[0,1,2,3,4,5]);assert.equal(p[1].y,-62.5);assert.equal(p[1].x,35);
    assert.ok(Math.abs(p[4].x-p[0].x)<1e-9);assert.equal(p[4].z,p[0].z);assert.equal(p[5].y,75);
    assert.ok(Math.abs(p[5].x-35/Math.sqrt(2))<1e-9);
  });
  await test('bad or incomplete physical geometry is rejected at device boundary',async()=>{
    const physical={...info,layout:{...info.layout,anglesDeg:[0,90,180,270,360,45],heightsMm:[0,12.5,29,77,120,150]}};
    for(const field of ['anglesDeg','heightsMm'])for(const bad of [undefined,null,[],[0],[0,0,0,0,0,NaN],[0,0,0,0,0,-1],[0,0,0,0,0,'1']]){
      assert.throws(()=>validateInfo({...physical,layout:{...physical.layout,[field]:bad}},key),{code:'protocol_mismatch'});
    }
    assert.throws(()=>validateInfo({...physical,layout:{...physical.layout,anglesDeg:[0,0,0,0,0,361]}},key),{code:'protocol_mismatch'});
    assert.throws(()=>validateInfo({...physical,layout:{...physical.layout,heightsMm:[0,0,0,0,0,151]}},key),{code:'protocol_mismatch'});
  });
  await test('3D projection rotates LEDs and picking selects front points only',async()=>{
    const p={index:0,x:0,y:0,z:35};const front=projectPoint(p,300,400,info.layout,0,0);assert.equal(front.x,150);assert.equal(front.y,200);assert.equal(hitTest([{...front,radius:6}],150,200),0);
    const back=projectPoint(p,300,400,info.layout,Math.PI,0);assert.equal(hitTest([{...back,radius:6}],back.x,back.y),null);assert.equal(hitTest([{...front,radius:6}],0,0),null);
  });
  await test('wheel spans basic hues, white center and sixteen distinct swatches',async()=>{
    assert.equal(hsvToHex(0,1),'#ff0000');assert.equal(hsvToHex(120,1),'#00ff00');assert.equal(hsvToHex(240,1),'#0000ff');assert.equal(hsvToHex(200,0),'#ffffff');assert.equal(palette.length,16);assert.equal(new Set(palette.map(p=>p[1])).size,16);assert.equal(hexToHsv('#00ff00').h,120);
  });
  console.log(n + ' client and geometry tests passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
