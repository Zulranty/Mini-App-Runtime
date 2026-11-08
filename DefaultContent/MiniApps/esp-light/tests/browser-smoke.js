async (page) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const info={"service":"miniapp-light","version":3,"deviceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Test-Lamp","access":"open","ledCount":116,"maxCurrentMa":500,"maxTimerMinutes":1440,"fireDefaults":{"speed":50,"height":50,"width":50,"smooth":50,"intensity":50,"color":"#ff6000"},"effects":["color","wheel","rainbow","fire","custom"],"layout":{"rows":15,"columns":8,"rowStarts":[0,8,16,23,31,39,46,54,62,69,77,85,92,100,108],"rowLengths":[8,8,7,8,8,7,8,8,7,8,8,7,8,8,8],"serpentine":false,"radiusMm":42,"heightMm":150,"anglesDeg":[0,46.55,93.1,139.66,186.21,232.76,279.31,325.86,12.41,58.97,105.52,152.07,198.62,245.17,291.72,338.28,24.83,71.38,117.93,164.48,211.03,257.59,304.14,350.69,37.24,83.79,130.34,176.9,223.45,270,316.55,3.1,49.66,96.21,142.76,189.31,235.86,282.41,328.97,15.52,62.07,108.62,155.17,201.72,248.28,294.83,341.38,27.93,74.48,121.03,167.59,214.14,260.69,307.24,353.79,40.34,86.9,133.45,180,226.55,273.1,319.66,6.21,52.76,99.31,145.86,192.41,238.97,285.52,332.07,18.62,65.17,111.72,158.28,204.83,251.38,297.93,344.48,31.03,77.59,124.14,170.69,217.24,263.79,310.34,356.9,43.45,90,136.55,183.1,229.66,276.21,322.76,9.31,55.86,102.41,148.97,195.52,242.07,288.62,335.17,21.72,68.28,114.83,161.38,207.93,254.48,301.03,347.59,34.14,80.69,127.24,173.79,220.35,266.9,313.45],"heightsMm":[0,1.3,2.61,3.91,5.22,6.52,7.83,9.13,10.43,11.74,13.04,14.35,15.65,16.96,18.26,19.57,20.87,22.17,23.48,24.78,26.09,27.39,28.7,30,31.3,32.61,33.91,35.22,36.52,37.83,39.13,40.43,41.74,43.04,44.35,45.65,46.96,48.26,49.57,50.87,52.17,53.48,54.78,56.09,57.39,58.7,60,61.3,62.61,63.91,65.22,66.52,67.83,69.13,70.43,71.74,73.04,74.35,75.65,76.96,78.26,79.57,80.87,82.17,83.48,84.78,86.09,87.39,88.7,90,91.3,92.61,93.91,95.22,96.52,97.83,99.13,100.43,101.74,103.04,104.35,105.65,106.96,108.26,109.57,110.87,112.17,113.48,114.78,116.09,117.39,118.7,120,121.3,122.61,123.91,125.22,126.52,127.83,129.13,130.43,131.74,133.04,134.35,135.65,136.96,138.26,139.57,140.87,142.17,143.48,144.78,146.09,147.39,148.7,150]}},id=info.deviceId;
    const state={deviceId:id,on:false,brightness:128,brightnessPercent:50,currentLimitMa:250,color:'#ff8844',effect:'color',rainbowMode:'forward',fire:{...info.fireDefaults},timer:{active:false,minutes:0,remainingSeconds:0},pixels:'000000'.repeat(info.ledCount)};
    const stored=new Map();let allowed=false,online=true,offset=0,started=0;
    function update(){
      state.brightness=Math.round(state.brightnessPercent*255/100);state.currentLimitMa=Math.round(info.maxCurrentMa*state.brightnessPercent/100);
      if(state.timer.active){state.timer.remainingSeconds=Math.max(0,Math.ceil((state.timer.minutes*60000-(Date.now()+offset-started))/1000));if(!state.timer.remainingSeconds){state.timer.active=false;state.on=false;}}
    }
    window.testLamp={state,info,stored,requests:[],setOnline:value=>online=value,advance:ms=>{offset+=ms;update();}};
    window.mini={runtime:{supports:async()=>true},permissions:{query:async name=>name==='network'&&!allowed?'prompt':'granted'},storage:{get:async k=>structuredClone(stored.get(k)??null),set:async(k,v)=>stored.set(k,structuredClone(v))},events:{on:()=>{}},network:{
      discoverDevices:async()=>{allowed=true;return online?[{id:'lamp',deviceId:id,name:info.name,service:'miniapp-light'}]:[];},
      requestDevice:async request=>{
        window.testLamp.requests.push(request);
        if((request.method==='POST'||request.path==='/api/sync')&&window.pendingGate)await window.pendingGate;
        if('token' in request)throw new Error('Unexpected token');if(!online)throw new Error('Device offline');
        update();const response=value=>({ok:true,status:200,body:{data:JSON.stringify(value)}});
        if(request.path==='/api/info')return response(info);if(request.path==='/api/sync')return response({deviceId:id,info,state});
        if(request.method==='POST'){
          const form=new URLSearchParams(request.body);
          for(const [key,value] of form){
            if(key==='on')state.on=value==='1';else if(key==='brightnessPercent')state.brightnessPercent=Number(value);else if(key==='brightness')state.brightnessPercent=Math.round(Number(value)*100/255);
            else if(key==='color')state.color='#'+value;else if(key==='effect'||key==='rainbowMode')state[key]=value;
            else if(key==='fireColor')state.fire.color='#'+value;else if(key.startsWith('fire'))state.fire[key[4].toLowerCase()+key.slice(5)]=Number(value);
          }
          if(form.has('resetFire'))state.fire={...info.fireDefaults};if(form.has('clear'))state.pixels='000000'.repeat(info.ledCount);if(form.has('pixels'))state.pixels=form.get('pixels');
          if(form.has('index')){const n=Number(form.get('index'))*6,color=form.get('pixel'),next=form.has('toggle')&&state.pixels.slice(n,n+6)===color?'000000':color;state.pixels=state.pixels.slice(0,n)+next+state.pixels.slice(n+6);}
          if(form.has('timerMinutes')){state.timer.minutes=Number(form.get('timerMinutes'));state.timer.active=state.timer.minutes>0&&state.on;started=Date.now()+offset;state.timer.remainingSeconds=state.timer.active?state.timer.minutes*60:0;}
          if(!state.on){state.timer.active=false;state.timer.remainingSeconds=0;}
        }
        update();return response(state);
      }
    }};
  });
  await page.goto('http://127.0.0.1:8938/index.html');
  await page.locator('#connection-screen').waitFor({state:'visible'});
  if(await page.locator('#control-screen').isVisible())throw new Error('Controls shown while disconnected');
  await page.getByRole('button',{name:'Разрешить поиск в сети'}).click();
  await page.locator('#control-screen').waitFor({state:'visible'});
  if(await page.locator('#connection-screen').isVisible())throw new Error('Connection info stays visible after connect');
  if(await page.locator('header,footer,#pair,#token').count())throw new Error('Removed copy or pairing is present');
  if(await page.locator('#palette button').count()!==16)throw new Error('Not sixteen colors');
  await page.locator('#palette').getByRole('button',{name:'Красный',exact:true}).click();
  await page.waitForFunction(()=>window.testLamp.state.color==='#ff0000');
  await page.getByRole('button',{name:'Включить свет',exact:true}).click();
  await page.waitForFunction(()=>window.testLamp.state.on);
  await page.locator('#brightness').fill('0');await page.locator('#brightness').dispatchEvent('change');
  await page.waitForFunction(()=>window.testLamp.state.brightness===0);
  await page.locator('#effect').selectOption('wheel');
  await page.locator('#wheel-panel').waitFor({state:'visible'});
  const wheel=await page.locator('#wheel').boundingBox();
  await page.mouse.click(wheel.x+wheel.width*.82,wheel.y+wheel.height/2);
  await page.waitForFunction(()=>window.testLamp.state.effect==='wheel'&&window.testLamp.state.color!=='#ff0000');
  await page.locator('#effect').selectOption('rainbow');await page.locator('#rainbow-panel').waitFor({state:'visible'});
  await page.locator('#effect').selectOption('fire');await page.locator('#fire-panel').waitFor({state:'visible'});
  await page.locator('#effect').selectOption('custom');await page.locator('#custom-panel').waitFor({state:'visible'});
  await page.locator('#brush-color').fill('#00aaff');await page.locator('#brush-color').dispatchEvent('input');
  const dot=await page.evaluate(()=>{const p=lampView.projected.find(p=>p.index===0);const r=document.querySelector('#lamp').getBoundingClientRect();return{x:r.x+p.x,y:r.y+p.y};});
  await page.mouse.click(dot.x,dot.y);
  await page.waitForFunction(()=>window.testLamp.state.pixels.startsWith('00aaff'));
  await page.locator('#pixel-color').fill('#ff00ff');await page.locator('#pixel-color').dispatchEvent('change');
  await page.waitForFunction(()=>window.testLamp.state.pixels.startsWith('ff00ff'));
  await page.getByRole('button',{name:'Погасить LED',exact:true}).click();
  await page.waitForFunction(()=>window.testLamp.state.pixels.startsWith('000000'));
  await page.locator('#led-select').selectOption('115');await page.getByRole('button',{name:'Нанести',exact:true}).click();
  await page.waitForFunction(()=>window.testLamp.state.pixels.endsWith('00aaff'));
  const beforeRotation=await page.evaluate(()=>({yaw:lampView.yaw,posts:window.testLamp.requests.filter(r=>r.method==='POST').length}));
  await page.locator('#lamp').scrollIntoViewIfNeeded();
  const lamp=await page.locator('#lamp').boundingBox();
  await page.mouse.move(lamp.x+lamp.width/2,lamp.y+lamp.height/2);await page.mouse.down();await page.mouse.move(lamp.x+lamp.width/2+70,lamp.y+lamp.height/2,{steps:5});await page.mouse.up();
  if(!await page.evaluate(before=>lampView.yaw!==before.yaw&&window.testLamp.requests.filter(r=>r.method==='POST').length===before.posts,beforeRotation))throw new Error('Rotation paints a LED or does not rotate');
  await page.evaluate(()=>{window.testLamp.state.on=true;window.testLamp.state.brightness=166;window.testLamp.state.brightnessPercent=65;window.testLamp.state.pixels='ff0000'+window.testLamp.state.pixels.slice(6);});
  await page.getByRole('button',{name:'Синхронизировать',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#brightness').value==='65'&&document.querySelector('#power').getAttribute('aria-pressed')==='true');
  await page.setViewportSize({width:1000,height:1050});
  await page.screenshot({path:'Output/playwright/esp-light-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile overflow');
  await page.screenshot({path:'Output/playwright/esp-light-phone.png',fullPage:true});
  await page.getByRole('button',{name:'Очистить',exact:true}).click();await page.waitForFunction(()=>/^0+$/.test(window.testLamp.state.pixels));
  await page.evaluate(()=>window.testLamp.setOnline(false));
  await page.evaluate(()=>client.tick());
  await page.locator('#connection-screen').waitFor({state:'visible'});
  if(await page.locator('#control-screen').isVisible())throw new Error('Controls visible after disconnect');
  if(errors.length)throw new Error(errors.join(' / '));
  return{result:'PASS',checks:['connection/control separation','no header/footer','16 colors','wheel pointer','rainbow/fire','3D LED click','individual/brush color','last LED','rotate without paint','authoritative sync','clear','mobile overflow','disconnect','no script errors']};
}
