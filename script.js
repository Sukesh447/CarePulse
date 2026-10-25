/* CarePulse - behaviour (JavaScript) */

/* ===================== helpers & storage ===================== */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const store = {
  get(k, d){ try{ const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};
let meds = store.get('cp2_meds', null);
let log  = store.get('cp2_log', []);      // {date, medId, time, status:'taken'|'missed'}
let temp = store.get('cp2_temp', 34);
let sel = new Set();                      // medicines ticked on the My Medicines page
const save = () => { store.set('cp2_meds', meds); store.set('cp2_log', log); store.set('cp2_temp', temp); };

const pad = n => String(n).padStart(2, '0');
const dstr = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
const today = () => dstr(new Date());
const toMin = t => { const p = t.split(':').map(Number); return p[0]*60 + p[1]; };
const nowMin = () => { const n = new Date(); return n.getHours()*60 + n.getMinutes(); };
const fmt12 = t => { const p = t.split(':').map(Number); let h = p[0]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + pad(p[1]) + ' ' + ap; };
const bucket = t => { const h = toMin(t)/60; return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'night'; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cap = s => s.replace(/\b\w/g, c => c.toUpperCase());
const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); };
const minuteNow = () => { const t = Date.now(); return t - t % 60000; };   // start of this minute, so "now" counts
const DAYN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ===================== voice + sound output ===================== */
let voiceOn = true;
function speak(text, force){
  if((!voiceOn && !force) || !('speechSynthesis' in window)) return;
  try{ const u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; u.rate = 0.95; speechSynthesis.speak(u); }catch(e){}
}
function reply(text){ $('#reply').textContent = text; speak(text); }
let actx = null;
function beep(){
  try{
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if(actx.state === 'suspended') actx.resume();
    [0, 0.28].forEach(off => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + off;
      o.connect(g); g.connect(actx.destination); o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.start(t); o.stop(t + 0.24);
    });
  }catch(e){}
}

/* ===================== medicine forms, frequencies ===================== */
const FORMS = {
  tablet: {label: 'Tablet',  icon: '&#128138;',              unit: ['pill', 'pills'],               stockUnit: 'pills',        stock: 30,  qtyLabel: 'Pills Quantity',        doses: ['50 mg', '100 mg', '250 mg', '500 mg', '650 mg', '1000 mg']},
  capsule:{label: 'Capsule', icon: '<span class="i-caps"></span>', unit: ['capsule', 'capsules'],    stockUnit: 'capsules',     stock: 30,  qtyLabel: 'Capsules Quantity',     doses: ['50 mg', '100 mg', '250 mg', '500 mg']},
  liquid: {label: 'Liquid',  icon: '&#128137;',              unit: ['ml', 'ml'],                    stockUnit: 'ml',           stock: 100, qtyLabel: 'Amount per dose',       doses: ['125 mg/5 ml', '250 mg/5 ml', '500 mg/5 ml']},
  lotion: {label: 'Lotion',  icon: '&#129524;',              unit: ['application', 'applications'], stockUnit: 'applications', stock: 30,  qtyLabel: 'Applications per dose', doses: ['0.1%', '0.5%', '1%', '2.5%']},
  spray:  {label: 'Spray',   icon: '&#128168;',              unit: ['spray', 'sprays'],             stockUnit: 'sprays',       stock: 120, qtyLabel: 'Sprays per dose',       doses: ['50 mcg', '100 mcg', '250 mcg']}
};
const FREQ = {
  daily: {label: 'Everyday', n: 1}, twice: {label: 'Twice a day', n: 2}, thrice: {label: '3 times a day', n: 3},
  alt: {label: 'Every other day', n: 1}, days: {label: 'Specific days', n: 1}
};
const formOf = m => FORMS[m.form] || FORMS.tablet;
const perOf = m => (m && +m.perDose) || 1;
const stockText = m => m.stock + ' ' + formOf(m).stockUnit;
function schedText(m){
  const f = m.freq || 'daily';
  if(f === 'days') return (m.days || []).slice().sort().map(d => DAYN[d]).join(', ') || 'No days';
  if(f === 'alt') return 'Every other day';
  return (FREQ[f] || FREQ.daily).label;
}
function buildInfo(m){
  const F = formOf(m), q = perOf(m), p = [];
  if(m.dose) p.push(m.dose);
  p.push(q + ' ' + (q === 1 ? F.unit[0] : F.unit[1]));
  p.push(schedText(m));
  if(m.instr) p.push(m.instr);
  return p.join(' • ');
}
function activeOn(m, ds){            // is this medicine scheduled on this date?
  const f = m.freq || 'daily', cur = ds.split('-').map(Number);
  if(f === 'days') return (m.days || []).indexOf(new Date(cur[0], cur[1]-1, cur[2]).getDay()) >= 0;
  if(f === 'alt'){
    const st = (m.start || dstr(new Date(m.created))).split('-').map(Number);
    const diff = Math.round((Date.UTC(cur[0], cur[1]-1, cur[2]) - Date.UTC(st[0], st[1]-1, st[2])) / 86400000);
    return diff >= 0 && diff % 2 === 0;
  }
  return true;
}
function dosesPerDay(m){
  const f = m.freq || 'daily', n = m.times.length;
  return f === 'alt' ? n / 2 : f === 'days' ? n * ((m.days || []).length || 7) / 7 : n;
}
function daysLeft(m){ const per = perOf(m) * dosesPerDay(m); return per > 0 ? m.stock / per : 99; }
const lowStock = () => meds.filter(m => daysLeft(m) <= 3);
function nextDose(m){
  const now = Date.now();
  for(let i = 0; i < 15; i++){
    const d = new Date(); d.setDate(d.getDate() + i);
    if(!activeOn(m, dstr(d))) continue;
    const ts = m.times.slice().sort();
    for(let k = 0; k < ts.length; k++){
      const tp = ts[k].split(':').map(Number);
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tp[0], tp[1]).getTime();
      if(s >= now && s >= m.created) return {i: i, t: ts[k], date: d};
    }
  }
  return null;
}
const dayLabel = nd => nd.i === 0 ? 'Today' : nd.i === 1 ? 'Tomorrow' : DAYN[nd.date.getDay()] + ' ' + nd.date.getDate();

/* ===================== safety knowledge (small demo tables) ===================== */
const HEAT = ['insulin','glargine','lantus','lispro','humalog','ozempic','semaglutide','liraglutide','adalimumab','vaccine','latanoprost'];
const isHeat = n => HEAT.some(h => n.toLowerCase().indexOf(h) >= 0);
const PAIRS = [
  ['aspirin','warfarin','High Bleeding Risk','Taking {a} and {b} together increases internal bleeding risk. Consult a doctor immediately.'],
  ['aspirin','clopidogrel','Bleeding Risk','Taking {a} and {b} together can increase bleeding. Ask your doctor before combining them.'],
  ['warfarin','ibuprofen','High Bleeding Risk','{b} together with {a} raises the risk of serious bleeding. Consult a doctor.'],
  ['aspirin','ibuprofen','Stomach & Heart Risk','{b} can weaken the heart-protecting effect of {a} and irritate the stomach. Ask your pharmacist.'],
  ['lisinopril','ibuprofen','Kidney & Blood Pressure','Painkillers like {b} can reduce the effect of {a} and strain the kidneys. Ask your doctor.'],
  ['lisinopril','potassium','High Potassium','{a} with {b} can push potassium levels too high. Check with your doctor.'],
  ['sildenafil','nitroglycerin','Dangerous Low Blood Pressure','{a} with {b} can drop blood pressure dangerously. Do not combine without a doctor.']
];
function getInteractions(){
  const out = [];
  PAIRS.forEach(p => {
    const a = meds.find(m => m.name.toLowerCase().indexOf(p[0]) >= 0);
    const b = meds.find(m => m.name.toLowerCase().indexOf(p[1]) >= 0);
    if(a && b && a.id !== b.id) out.push({key: p[0] + p[1], title: p[2], text: p[3].replace('{a}', a.name).replace('{b}', b.name)});
  });
  return out;
}
function getHeat(){ return temp > 25 ? meds.filter(m => isHeat(m.name)) : []; }
function safetyCount(){ return getInteractions().length + (getHeat().length ? 1 : 0); }

/* ===================== schedule logic ===================== */
function dosesFor(dateStr){
  const out = [];
  meds.forEach(m => {
    if(!activeOn(m, dateStr)) return;
    m.times.forEach(t => {
      const dp = dateStr.split('-').map(Number), tp = t.split(':').map(Number);
      const sched = new Date(dp[0], dp[1]-1, dp[2], tp[0], tp[1]).getTime();
      if(sched < m.created) return;              // doses before the medicine was added don't count
      const e = log.find(l => l.date === dateStr && l.medId === m.id && l.time === t);
      out.push({med: m, time: t, sched: sched, status: e ? e.status : 'pending'});
    });
  });
  return out.sort((a, b) => a.sched - b.sched);
}
function setStatus(medId, time, status){
  const d = today(), m = meds.find(x => x.id === medId);
  const old = log.find(l => l.date === d && l.medId === medId && l.time === time);
  if(old){
    if(old.status !== 'taken' && status === 'taken' && m) m.stock = Math.max(0, m.stock - perOf(m));
    old.status = status;
  } else {
    log.push({date: d, medId: medId, time: time, status: status});
    if(status === 'taken' && m) m.stock = Math.max(0, m.stock - perOf(m));
  }
  save(); render();
}
function clearReminder(medId, time){
  reminders = reminders.filter(r => !(r.medId === medId && r.time === time));
  delete snoozed[medId + '|' + time];
}
function markTaken(medId, time){
  setStatus(medId, time, 'taken'); clearReminder(medId, time);
  render(); announceSafety();
}
function undoTaken(medId, time){
  const d = today(), i = log.findIndex(l => l.date === d && l.medId === medId && l.time === time && l.status === 'taken');
  if(i < 0) return;
  log.splice(i, 1);
  const m = meds.find(x => x.id === medId); if(m) m.stock += perOf(m);   // give the tablet back
  save(); render(); toast((m ? m.name : 'Dose') + ' marked as not taken.');
}
function deleteMeds(ids){
  const list = meds.filter(m => ids.indexOf(m.id) >= 0);
  if(!list.length) return false;
  if(!confirm('Delete ' + list.map(m => m.name).join(', ') + ' and its history?')) return false;
  meds = meds.filter(m => ids.indexOf(m.id) < 0);
  log = log.filter(l => ids.indexOf(l.medId) < 0);
  reminders = reminders.filter(r => ids.indexOf(r.medId) < 0);
  ids.forEach(id => sel.delete(id));
  save(); render();
  toast('Deleted ' + list.map(m => m.name).join(', ') + '.');
  return true;
}
const removeMed = id => deleteMeds([id]);
function toggleSel(id){ if(sel.has(id)) sel.delete(id); else sel.add(id); render(); }
function refillPrompt(id){
  const m = meds.find(x => x.id === id); if(!m) return;
  const n = parseInt(prompt('How many ' + formOf(m).stockUnit + ' did you add for ' + m.name + '?'), 10);
  if(n > 0){ m.stock += n; save(); render(); toast(m.name + ' now has ' + stockText(m) + '.'); }
}
function readAloud(id, time){
  const m = meds.find(x => x.id === id); if(!m) return;
  const info = (m.info || '').replace(/•/g, ',').replace(/(\d)\s?mg/gi, '$1 milligrams');
  speak(m.name + '. ' + info + '. Scheduled for ' + fmt12(time) + '.', true);
}

function addMedicine(o){
  const m = {
    id: newId(), name: o.name, form: o.form || 'tablet', dose: o.dose || '', perDose: o.perDose || 1,
    freq: o.freq || 'daily', days: o.days || null, instr: o.instr || '', times: o.times.slice().sort(),
    stock: o.stock, created: o.created || minuteNow(), start: today()
  };
  m.info = o.info || buildInfo(m);
  meds.push(m); save(); render(); announceSafety();
  const hasToday = dosesFor(today()).some(d => d.med.id === m.id);
  let msg = '';
  if(!hasToday){ const nd = nextDose(m); msg = nd ? ' First reminder: ' + dayLabel(nd) + ' at ' + fmt12(nd.t) + '.' : ''; }
  return {med: m, msg: msg, hasToday: hasToday};
}

/* ===================== reminders: on-screen + voice + sound + notification ===================== */
let reminders = [];            // cards shown on screen {medId,time,text,sub}
let snoozed = {};              // 'medId|time' -> time to remind again
const announced = new Set();
const spoken = new Set();
const baseTitle = document.title;

const NOTE_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#6a8f73"/><path d="M40 18h16v22h22v16H56v22H40V56H18V40h22z" fill="#fff"/></svg>');
let swReady = false;
function initSW(){
  try{
    if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
      navigator.serviceWorker.register('sw.js').then(() => { swReady = true; }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', e => {
        const d = e.data || {};
        if(d.type === 'taken' && d.medId) markTaken(d.medId, d.time);
        else if(d.type === 'snooze' && d.medId) snooze(d.medId, d.time);
      });
    }
  }catch(e){}
}
function showNotif(title, body, data){
  if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const tag = data ? data.medId + data.time : 'carepulse';
  const plain = () => { try{ new Notification(title, {body: body, icon: NOTE_ICON, tag: tag}); }catch(e){} };
  if(swReady){
    const opts = {body: body, icon: NOTE_ICON, tag: tag, renotify: true, requireInteraction: true, vibrate: [200, 100, 200], data: data || {},
      actions: data ? [{action: 'taken', title: 'Mark taken'}, {action: 'snooze', title: 'Snooze 10 min'}] : []};
    navigator.serviceWorker.ready.then(r => r.showNotification(title, opts)).catch(plain);
  } else plain();
  return true;
}
function notifState(){
  if(typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;     // 'default' | 'granted' | 'denied'
}
function enableReminders(){
  const st = notifState();
  if(st === 'unsupported'){ toast('This browser cannot show notifications. In-page reminders, voice and sound still work.'); return; }
  if(st === 'denied'){ toast('Notifications are blocked. Click the lock icon next to the address bar, set Notifications to Allow, then refresh.'); return; }
  if(st === 'granted'){ beep(); showNotif('CarePulse', 'Notifications are ON. You will get reminders like this one.'); toast('Notifications are on.'); render(); return; }
  Notification.requestPermission().then(p => {
    render();
    if(p === 'granted'){ beep(); showNotif('CarePulse', 'Notifications are ON. You will get reminders like this one.'); toast('Notifications enabled.'); }
    else toast('Notifications were not allowed. Voice and on-screen reminders still work.');
  });
}
let bannerHidden = false;
function bannerHTML(){
  const st = notifState();
  if(st === 'granted' || bannerHidden || view === 'add') return '';
  let msg, btn = '';
  if(location.protocol === 'file:') msg = 'To get popup notifications, open CarePulse through <b>Live Server</b> (http://127.0.0.1:5500) or the hosted link. Browsers block notifications for plain files. Voice and on-screen reminders still work.';
  else if(st === 'unsupported') msg = 'This browser cannot show popup notifications. Voice and on-screen reminders still work.';
  else if(st === 'denied') msg = 'Notifications are blocked. Click the lock icon next to the address bar, set <b>Notifications</b> to <b>Allow</b>, then refresh the page.';
  else { msg = 'Turn on notifications to get a popup reminder (with voice) even when this tab is in the background.'; btn = '<button class="sbtn" onclick="enableReminders()">Turn on</button>'; }
  return alertHTML('amber', '&#128276;', 'Notifications are off', msg, btn + '<button class="xbtn" onclick="bannerHidden=true;render()">&#10005;</button>');
}
function pushReminder(d, late){
  if(reminders.some(r => r.medId === d.med.id && r.time === d.time)) return;
  const text = late ? "Reminder: you still haven't taken " + d.med.name : 'Time to take ' + d.med.name;
  const sub = (d.med.info || '') + ' • scheduled for ' + fmt12(d.time);
  reminders.unshift({medId: d.med.id, time: d.time, text: text, sub: sub});
  speak((late ? '' : "It's " + fmt12(d.time) + '. ') + text + '.');
  beep();
  showNotif('⏰ ' + text, sub, {medId: d.med.id, time: d.time});
  if(document.hidden) document.title = '⏰ ' + text;
  render();
}
function snooze(medId, time){
  snoozed[medId + '|' + time] = Date.now() + 10 * 60000;
  reminders = reminders.filter(r => !(r.medId === medId && r.time === time));
  render(); toast('Snoozed for 10 minutes.');
}
function announceSafety(){
  getInteractions().forEach(i => { if(!spoken.has('i' + i.key)){ spoken.add('i' + i.key); speak('Warning. ' + i.title + '. ' + i.text); } });
  const h = getHeat();
  if(h.length && !spoken.has('h' + today())){ spoken.add('h' + today()); speak('Heat alert. ' + h.map(x => x.name).join(' and ') + ' needs cool storage.'); }
  lowStock().forEach(m => {
    const k = 'r' + m.id + today() + (m.stock === 0 ? 'z' : '');
    if(!spoken.has(k)){
      spoken.add(k);
      const t = m.stock === 0 ? m.name + ' is finished. Please refill it now.' : 'Only ' + (Math.floor(daysLeft(m) * 10) / 10) + ' days of ' + m.name + ' left. Time to refill.';
      speak(t); showNotif('🛒 Refill reminder', t);
    }
  });
}
function tick(){
  const nm = nowMin(), now = Date.now();
  let changed = false;
  dosesFor(today()).forEach(d => {
    if(d.status !== 'pending') return;
    const key = d.med.id + '|' + d.time;
    if(snoozed[key]){ if(now >= snoozed[key]){ delete snoozed[key]; pushReminder(d, true); } return; }
    const diff = nm - toMin(d.time);
    if(diff >= 0 && diff <= 60){
      const k = today() + key + Math.floor(diff / 15);        // reminds again every 15 minutes
      if(!announced.has(k)){ announced.add(k); pushReminder(d, diff >= 15); }
    } else if(diff > 60){
      log.push({date: today(), medId: d.med.id, time: d.time, status: 'missed'}); changed = true;
    }
  });
  if(changed) save();
  announceSafety();
  render();
}

/* ===================== "AI": adherence prediction ===================== */
function riskModel(){
  const g = {}, mb = {};
  log.forEach(l => {
    const b = bucket(l.time), k = l.medId + '|' + b;
    g[b] = g[b] || {m: 0, t: 0}; g[b].t++; if(l.status === 'missed') g[b].m++;
    mb[k] = mb[k] || {m: 0, t: 0}; mb[k].t++; if(l.status === 'missed') mb[k].m++;
  });
  const slot = b => { const G = g[b] || {m: 0, t: 0}; return (G.m + 1) / (G.t + 2); };
  const p = (medId, time) => {
    const b = bucket(time), pg = slot(b), M = mb[medId + '|' + b] || {m: 0, t: 0};
    return (M.m + 3 * pg) / (M.t + 3);
  };
  p.slot = slot; p.counts = g;
  return p;
}

/* ===================== "AI": voice command understanding ===================== */
function normalize(s){
  return s.toLowerCase().replace(/p\.m\./g, 'pm').replace(/a\.m\./g, 'am')
    .replace(/milligrams?/g, 'mg').replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractTimes(s){
  const times = [];
  s = s.replace(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/g, (x, h, m, ap) => {
    h = (+h) % 12; if(ap === 'pm') h += 12; times.push(pad(h) + ':' + pad(m || 0)); return ' ';
  });
  s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (x, h, m) => { times.push(pad(h) + ':' + m); return ' '; });
  const words = {morning: '08:00', afternoon: '14:00', evening: '19:00', night: '21:00', noon: '12:00', bedtime: '22:00'};
  s = s.replace(/\b(morning|afternoon|evening|night|noon|bedtime)\b/g, (x, w) => { times.push(words[w]); return ' '; });
  return {times: Array.from(new Set(times)).sort(), rest: s};
}
function findMed(s){
  let m = meds.find(x => s.indexOf(x.name.toLowerCase()) >= 0);
  if(m) return m;
  const tokens = s.split(' ');
  return meds.find(x => tokens.indexOf(x.name.toLowerCase().split(' ')[0]) >= 0) || null;
}
function cmdAdd(s){
  let t = s.replace(/^.*?\b(add|new)\b/, '');
  const ex = extractTimes(t); t = ex.rest;
  let dose = '';
  t = t.replace(/(\d+(?:\.\d+)?)\s?(mg|ml|mcg|g)\b/, (m, n, u) => { dose = n + ' ' + u; return ' '; });
  let stock = null;
  t = t.replace(/(?:stock|quantity|qty|have|with)\s*(\d+)/, (m, n) => { stock = +n; return ' '; });
  t = t.replace(/(\d+)\s*(tablets?|pills?|capsules?|tabs?)/, (m, n) => { if(stock === null) stock = +n; return ' '; });
  t = t.replace(/\b(a|an|the|my|medicine|medication|tablet|tablets|pill|pills|capsule|capsules|at|for|in|and|every|day|daily|reminder|remind|me|to|take|new|of|please|once|twice|thrice|times|time|stock|with|three)\b/g, ' ');
  const name = t.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  if(!name){ reply("Sorry, I didn't catch the medicine name. Try: add paracetamol 500 mg at 9 pm."); return; }
  let times = ex.times;
  if(!times.length) times = /twice/.test(s) ? ['08:00', '20:00'] : /thrice|three times/.test(s) ? ['08:00', '14:00', '20:00'] : ['08:00'];
  times = times.slice(0, 3);
  const freq = times.length === 2 ? 'twice' : times.length === 3 ? 'thrice' : 'daily';
  const r = addMedicine({name: cap(name), dose: dose, times: times, stock: stock === null ? 30 : stock, freq: freq});
  reply('Added ' + cap(name) + (dose ? ' ' + dose : '') + ' at ' + times.map(fmt12).join(' and ') + '.' + r.msg);
}
function cmdTaken(s){
  const m = findMed(s);
  let cand = dosesFor(today()).filter(d => d.status !== 'taken');
  if(m) cand = cand.filter(d => d.med.id === m.id);
  const sl = s.match(/morning|afternoon|evening|night/);
  let targets = [];
  if(sl){
    const b = sl[0] === 'evening' ? 'night' : sl[0];
    targets = cand.filter(d => bucket(d.time) === b);
  } else if(cand.length){
    const nm = nowMin();
    cand.sort((a, b) => Math.abs(toMin(a.time) - nm) - Math.abs(toMin(b.time) - nm));
    targets = [cand[0]];
  }
  if(!targets.length){
    const all = dosesFor(today()).filter(d => (!m || d.med.id === m.id) && (!sl || bucket(d.time) === (sl[0] === 'evening' ? 'night' : sl[0])));
    if(all.length && all.every(d => d.status === 'taken')){ reply('That dose is already marked as taken. Well done!'); return; }
    reply(m ? 'There is no pending dose of ' + m.name + ' right now.' : 'I could not find a pending dose to mark as taken.'); return;
  }
  targets.forEach(d => { setStatus(d.med.id, d.time, 'taken'); clearReminder(d.med.id, d.time); });
  reply('Done. Marked ' + targets.map(d => d.med.name).join(' and ') + ' as taken.');
  render(); announceSafety();
}
function cmdUndo(s){
  const m = findMed(s);
  let cand = dosesFor(today()).filter(d => d.status === 'taken' && (!m || d.med.id === m.id));
  const sl = s.match(/morning|afternoon|evening|night/);
  if(sl) cand = cand.filter(d => bucket(d.time) === (sl[0] === 'evening' ? 'night' : sl[0]));
  if(!cand.length){ reply('There is no taken dose to undo.'); return; }
  const nm = nowMin();
  cand.sort((a, b) => Math.abs(toMin(a.time) - nm) - Math.abs(toMin(b.time) - nm));
  undoTaken(cand[0].med.id, cand[0].time);
  reply('Okay. ' + cand[0].med.name + ' is marked as not taken.');
}
function cmdRemove(s){
  const m = findMed(s);
  if(!m){ reply('Which medicine should I remove? Try: remove aspirin.'); return; }
  reply(deleteMeds([m.id]) ? 'Removed ' + m.name + '.' : 'Okay, I did not remove ' + m.name + '.');
}
function cmdList(){
  view = 'meds'; render(); window.scrollTo(0, 0);
  reply(meds.length ? 'You have ' + meds.length + ' medicines: ' + meds.map(m => m.name).join(', ') + '.' : 'You have not added any medicines yet.');
}
function cmdStock(s){
  const m = findMed(s);
  if(m){ reply(m.name + ' has ' + stockText(m) + ' left, about ' + (Math.floor(daysLeft(m) * 10) / 10) + ' days.'); return; }
  if(!meds.length){ reply('You have not added any medicines yet.'); return; }
  reply(meds.map(x => x.name + ': ' + stockText(x) + ' left').join('. '));
}
function cmdRefill(s){
  const m = findMed(s), n = (s.match(/\d+/) || [])[0];
  if(!m){ reply('Which medicine did you refill? Try: I bought 30 aspirin.'); return; }
  if(!n){ reply('How many did you add for ' + m.name + '?'); return; }
  m.stock += +n; save(); render();
  reply('Refilled. ' + m.name + ' now has ' + stockText(m) + '.');
}
function cmdSchedule(){
  const nm = nowMin();
  const p = dosesFor(today()).filter(d => d.status === 'pending' && toMin(d.time) >= nm - 60);
  if(!p.length){ reply('You have no more doses pending today. Well done!'); return; }
  reply('Next: ' + p.slice(0, 3).map(d => d.med.name + ' at ' + fmt12(d.time)).join(', then ') + '.');
}
function runCommand(raw){
  const s = normalize(raw || '');
  if(!s) return;
  $('#cmd').value = raw;
  if(/\b(undo|untake|untaken|unmark)\b|\b(didn t|didn't|did not|haven t|haven't|have not) (take|took|have)/.test(s)) return cmdUndo(s);
  if(/\b(delete|remove)\b/.test(s)) return cmdRemove(s);
  if(/\b(refill|refilled|restock|bought|purchased)\b/.test(s)) return cmdRefill(s);
  if(/\b(add|new medicine)\b/.test(s)) return cmdAdd(s);
  if(/\b(took|taken|had|swallowed|finished|mark)\b/.test(s)) return cmdTaken(s);
  if(/\b(show|list|view|all)\b.*\b(medicines|medications|medicine|pills)\b/.test(s)) return cmdList();
  if(/\b(how many|how much|left|remaining|stock)\b/.test(s)) return cmdStock(s);
  if(/\b(next|today|schedule|due|what|take)\b/.test(s)) return cmdSchedule();
  reply("Sorry, I didn't understand. Try: 'I took my morning tablet', 'add paracetamol 500 mg at 9 pm', 'remove aspirin', 'show all medicines' or 'what is next'.");
}

/* ===================== microphone ===================== */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if(SR){
  rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onstart = () => { $('#micBtn').classList.add('on'); $('#micBtn').textContent = 'Listening...'; };
  rec.onend = () => { $('#micBtn').classList.remove('on'); $('#micBtn').innerHTML = '&#127908; Tap and speak'; };
  rec.onresult = e => runCommand(e.results[0][0].transcript);
  rec.onerror = e => {
    const msg = {'not-allowed': 'Microphone permission is blocked. Click the lock icon near the address bar and allow the microphone.',
      'network': 'Voice recognition needs an internet connection.', 'no-speech': "I didn't hear anything. Tap the mic and try again."};
    $('#reply').textContent = msg[e.error] || 'Voice error: ' + e.error + '. You can type the command instead.';
  };
}
$('#micBtn').onclick = () => {
  if(!rec){ $('#reply').textContent = 'Voice recognition is not supported in this browser. Please use Google Chrome or Edge, or type the command.'; return; }
  try{ speechSynthesis.cancel(); rec.start(); }catch(e){}
};
$('#cmd').addEventListener('keydown', e => { if(e.key === 'Enter') runCommand($('#cmd').value); });
const examples = ['I took my morning tablet', 'Undo aspirin', 'Add paracetamol 500 mg at 9 pm', 'Remove aspirin', 'Show all medicines', 'What is next'];
$('#chips').innerHTML = examples.map(x => '<button class="chip" type="button">' + esc(x) + '</button>').join('');
$$('.chip').forEach(c => c.onclick = () => runCommand(c.textContent));
$('#voiceToggle').onclick = () => {
  voiceOn = !voiceOn;
  $('#voiceToggle').innerHTML = '&#128266; Voice: ' + (voiceOn ? 'ON' : 'OFF');
  if(!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
};

/* ===================== Add Medicine page ===================== */
const addState = {form: 'tablet', freq: 'daily', days: [1, 2, 3, 4, 5], stockTouched: false};
const DEFT = {1: ['09:00'], 2: ['08:00', '20:00'], 3: ['08:00', '14:00', '20:00']};
function renderFormChips(){
  $('#formChips').innerHTML = Object.keys(FORMS).map(k =>
    '<button type="button" class="fchip' + (k === addState.form ? ' on' : '') + '" data-form="' + k + '"><span class="fi">' + FORMS[k].icon + '</span>' + FORMS[k].label + '</button>').join('');
  $$('#formChips .fchip').forEach(b => b.onclick = () => { addState.form = b.getAttribute('data-form'); renderFormChips(); updateFormUI(); });
}
function updateFormUI(){
  const F = FORMS[addState.form];
  $('#qtyLabel').textContent = F.qtyLabel;
  $('#fQtyUnit').textContent = F.unit[1];
  $('#fDose').innerHTML = F.doses.map(x => '<option' + (x === '250 mg' ? ' selected' : '') + '>' + x + '</option>').join('') + '<option value="__other">Other...</option>';
  $('#fDoseOther').hidden = true;
  $('#stockLabel').textContent = 'Total in stock (' + F.stockUnit + ')';
  if(!addState.stockTouched) $('#fStock').value = F.stock;
}
function renderDayChips(){
  $('#dayChips').hidden = addState.freq !== 'days';
  $('#dayChips').innerHTML = DAYN.map((d, i) => '<button type="button" class="dchip' + (addState.days.indexOf(i) >= 0 ? ' on' : '') + '" data-d="' + i + '">' + d + '</button>').join('');
  $$('#dayChips .dchip').forEach(b => b.onclick = () => {
    const i = +b.getAttribute('data-d'), at = addState.days.indexOf(i);
    if(at >= 0) addState.days.splice(at, 1); else addState.days.push(i);
    renderDayChips();
  });
}
function buildTimes(){
  const n = FREQ[addState.freq].n, old = $$('#timeList .tinp').map(i => i.value);
  let h = '';
  for(let i = 0; i < n; i++)
    h += '<div class="trow"><span class="tic">&#9201;&#65039;</span><input type="time" class="tinp" required value="' + (old[i] || DEFT[n][i]) + '"></div>';
  $('#timeList').innerHTML = h;
}
function initAddForm(){
  $('#fFreq').innerHTML = Object.keys(FREQ).map(k => '<option value="' + k + '">' + FREQ[k].label + '</option>').join('');
  renderFormChips(); updateFormUI(); renderDayChips(); buildTimes();
  $('#fFreq').onchange = () => { addState.freq = $('#fFreq').value; renderDayChips(); buildTimes(); };
  $('#fDose').onchange = () => { $('#fDoseOther').hidden = $('#fDose').value !== '__other'; if(!$('#fDoseOther').hidden) $('#fDoseOther').focus(); };
  $('#fStock').oninput = () => { addState.stockTouched = true; };
}
function resetAddForm(){
  addState.form = 'tablet'; addState.freq = 'daily'; addState.days = [1, 2, 3, 4, 5]; addState.stockTouched = false;
  $('#fName').value = ''; $('#fInstr').value = ''; $('#fQty').value = 1; $('#fFreq').value = 'daily'; $('#fDoseOther').value = '';
  renderFormChips(); updateFormUI(); renderDayChips(); buildTimes();
}
$('#addForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#fName').value.trim();
  const times = $$('#timeList .tinp').map(i => i.value).filter(Boolean);
  if(!name){ toast("Please type the medicine's name."); return; }
  if(new Set(times).size < FREQ[addState.freq].n){ toast('Please choose a different time for each dose.'); return; }
  if(addState.freq === 'days' && !addState.days.length){ toast('Please pick at least one day of the week.'); return; }
  let dose = $('#fDose').value;
  if(dose === '__other') dose = $('#fDoseOther').value.trim();
  const r = addMedicine({
    name: cap(name), form: addState.form, dose: dose, perDose: Math.max(1, +$('#fQty').value || 1), freq: addState.freq,
    days: addState.freq === 'days' ? addState.days.slice() : null, instr: $('#fInstr').value.trim(),
    times: times, stock: Math.max(0, +$('#fStock').value || 0)
  });
  resetAddForm();
  view = r.hasToday ? 'daily' : 'meds';
  render(); window.scrollTo(0, 0);
  toast('Saved ' + r.med.name + '.' + r.msg);
  speak('Saved ' + r.med.name + '.' + r.msg);
});

/* ===================== buttons & navigation ===================== */
let view = 'daily', prevView = 'daily';
function openAdd(){ if(view !== 'add') prevView = view; view = 'add'; render(); window.scrollTo(0, 0); setTimeout(() => $('#fName').focus(), 50); }
$('#addBtn').onclick = openAdd;
$('#addBtn2').onclick = openAdd;
$('#fabBtn').onclick = openAdd;
$('#backBtn').onclick = () => { view = prevView === 'add' ? 'daily' : prevView; render(); window.scrollTo(0, 0); };
$('#allBtn').onclick = () => { view = 'meds'; render(); window.scrollTo(0, 0); };
$$('[data-nav]').forEach(b => b.onclick = () => { view = b.getAttribute('data-nav'); render(); window.scrollTo(0, 0); });
$('#selAll').onchange = () => { if($('#selAll').checked) meds.forEach(m => sel.add(m.id)); else sel.clear(); render(); };
$('#delSel').onclick = () => deleteMeds(Array.from(sel));
$('#clashBtn').onclick = () => {
  if(meds.some(m => m.name.toLowerCase().indexOf('warfarin') >= 0)){ toast('Warfarin is already added. Remove it to reset the demo.'); return; }
  if(!meds.some(m => m.name.toLowerCase().indexOf('aspirin') >= 0)) addMedicine({name: 'Aspirin', dose: '75 mg', instr: 'After dinner', times: ['20:00'], stock: 30, created: startOfToday()});
  addMedicine({name: 'Warfarin', dose: '5 mg', instr: 'Evening dose', times: ['21:00'], stock: 20, created: startOfToday()});
  toast('Drug clash simulated: Aspirin + Warfarin.');
};
let showReport = false;
$('#reportBtn').onclick = () => {
  showReport = !showReport;
  $('#reportBtn').innerHTML = '&#129658; ' + (showReport ? 'Hide' : 'View') + ' 10-Sec Doctor Report';
  render();
};
$('#remBtn').onclick = enableReminders;
$('#testBtn').onclick = () => {
  const ds = dosesFor(today());
  const d = ds.find(x => x.status === 'pending') || ds.find(x => x.status === 'missed');
  if(d){ pushReminder(d, false); return; }
  beep(); speak('This is a test reminder from CarePulse.');
  showNotif('⏰ CarePulse test', 'Reminders are working.');
  toast(meds.length ? 'No pending dose right now. Sent a test sound, voice and notification.' : 'Add a medicine first. Sent a test sound and voice.');
};
$('#tempChip').onclick = () => {
  const v = parseFloat(prompt('Outdoor temperature in °C (for the heat-storage check):', temp));
  if(!isNaN(v)){ temp = v; save(); render(); announceSafety(); }
};
$('#resetDemo').onclick = () => { if(confirm('Reset everything to the demo data?')){ seedDemo(); render(); toast('Demo data restored.'); } };

/* ===================== demo data ===================== */
function seedDemo(){
  const now = Date.now(), DAY = 86400000;
  meds = [
    {id: 'demo1', name: 'Lisinopril', form: 'tablet', dose: '10 mg', perDose: 1, freq: 'daily', times: ['08:00'], stock: 24, created: now - 15 * DAY, info: '10 mg • Morning with water'},
    {id: 'demo2', name: 'Insulin Glargine', form: 'liquid', dose: '100 units/ml', perDose: 15, freq: 'daily', times: ['13:00'], stock: 300, created: now - 15 * DAY, info: '15 Units • Subcutaneous'},
    {id: 'demo3', name: 'Aspirin', form: 'tablet', dose: '75 mg', perDose: 1, freq: 'daily', times: ['20:00'], stock: 3, created: now - 15 * DAY, info: '75 mg • After dinner'}
  ];
  log = [];
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const okRate = {morning: 0.94, afternoon: 0.8, night: 0.6};
  for(let i = 14; i >= 0; i--){
    const ds = dstr(new Date(now - i * DAY));
    dosesFor(ds).forEach(d => {
      if(d.sched < now - 60 * 60000)
        log.push({date: ds, medId: d.med.id, time: d.time, status: (i === 0 || rnd() < okRate[bucket(d.time)]) ? 'taken' : 'missed'});
    });
  }
  reminders = []; snoozed = {}; spoken.clear(); announced.clear(); sel.clear();
  save();
}
if(!meds){ meds = []; seedDemo(); }
meds.forEach(m => { if(!m.times || !m.times.length) m.times = ['09:00']; });   // safety for old saved data

/* ===================== rendering ===================== */
function snapshotHTML(){
  const ds = dosesFor(today()), done = ds.filter(d => d.status === 'taken').length;
  const pct = ds.length ? Math.round(done / ds.length * 100) : 0;
  const taken = log.filter(l => l.status === 'taken').length;
  const hist = log.length ? Math.round(taken / log.length * 100) + '% over ' + log.length + ' recorded doses' : 'no history yet';
  const pres = meds.length ? meds.map(m => esc(m.name) + ' (' + esc(m.info || 'no dose info') + ' at ' + m.times.join(', ') + ')').join(' | ') : 'none';
  const ints = getInteractions(), heat = meds.filter(m => isHeat(m.name)), low = lowStock();
  return '<div class="st">&#129658; Clinical Triage Snapshot (10-Second Doctor Summary)</div>' +
    '<div><b>Adherence Score:</b> ' + pct + '% (' + done + ' of ' + ds.length + ' doses completed today)</div>' +
    '<div><b>Long-term adherence:</b> ' + hist + '</div>' +
    '<div><b>Active Prescriptions:</b> ' + pres + '</div>' +
    '<div><b>Safety Status:</b> ' + (ints.length ? ints.length + ' potential drug clash(es) flagged: ' + ints.map(i => esc(i.title)).join(', ') : 'No drug clashes flagged') + '</div>' +
    '<div><b>Storage:</b> ' + (heat.length ? esc(heat.map(m => m.name).join(', ')) + ' need cool storage (below 25°C)' : 'No heat-sensitive medicines') + '</div>' +
    '<div><b>Refills needed:</b> ' + (low.length ? esc(low.map(m => m.name + ' (' + stockText(m) + ' left)').join(', ')) : 'none') + '</div>';
}
function alertHTML(cls, icon, title, text, buttons){
  return '<div class="alert ' + cls + '"><div class="ai">' + icon + '</div><div><div class="at">' + title + '</div><div class="ad">' + text + '</div></div>' +
    (buttons ? '<div class="ab">' + buttons + '</div>' : '') + '</div>';
}
function medRow(m){
  const F = formOf(m), dl = daysLeft(m), low = dl <= 3, nd = nextDose(m), on = sel.has(m.id);
  return '<div class="mrow' + (on ? ' sel' : '') + '">' +
    '<input type="checkbox" class="chk" ' + (on ? 'checked ' : '') + 'onchange="toggleSel(\'' + m.id + '\')">' +
    '<div class="ic">' + F.icon + '</div>' +
    '<div class="im"><div class="iname">' + esc(m.name) + ' <span class="tag">' + F.label + '</span></div><div class="isub">' + esc(m.info || '') + '</div>' +
    '<div class="mtimes">' + m.times.map(t => '<span class="tag">&#9200; ' + fmt12(t) + '</span>').join('') + '<span class="tag">' + esc(schedText(m)) + '</span>' +
    '<span class="tag ' + (low ? 'low' : '') + '">&#128230; ' + esc(stockText(m)) + ' left (about ' + (Math.floor(dl * 10) / 10) + ' days)</span>' + (low ? '<span class="tag low">Refill soon</span>' : '') + '</div>' +
    '<div class="isched" style="margin-top:8px">' + (nd ? 'Next dose: ' + dayLabel(nd) + ' at ' + fmt12(nd.t) : 'No upcoming dose') + '</div></div>' +
    '<div class="ib"><button class="btns" onclick="refillPrompt(\'' + m.id + '\')">+ Refill</button>' +
    '<button class="btnx" onclick="removeMed(\'' + m.id + '\')">&#128465;&#65039; Delete</button></div></div>';
}
function render(){
  /* views + nav */
  $$('[data-view]').forEach(s => { s.hidden = s.getAttribute('data-view') !== view; });
  $$('[data-nav]').forEach(b => b.classList.toggle('active', b.getAttribute('data-nav') === (view === 'add' ? 'meds' : view)));
  $('#fabBtn').hidden = view === 'add';
  $('#pageTitle').textContent = {daily: 'Your Daily Wellness', meds: 'My Medicines', add: 'New Medicine', safety: 'Safety & Climate', triage: 'Doctor Triage Card'}[view];
  $('#notifBanner').innerHTML = bannerHTML();
  const nst = notifState();
  $('#remBtn').innerHTML = nst === 'granted' ? '&#128276; Notifications: ON' : '&#128276; Enable Reminders';

  /* temperature */
  $('#tempVal').textContent = temp + '°C';
  $('#tempState').textContent = temp > 25 ? 'Cool Down' : 'Normal';
  $('#tempState').className = 'mini' + (temp > 25 ? '' : ' hot');
  const nHeat = meds.filter(m => isHeat(m.name)).length;
  $('#climateTxt').textContent = 'Local temp: ' + temp + '°C. ' + nHeat + ' medicine(s) require cool storage.';

  const ds = dosesFor(today()), done = ds.filter(d => d.status === 'taken').length;
  const risk = riskModel(), learned = log.length >= 6;
  const ints = getInteractions(), heat = getHeat(), sc = safetyCount();
  $('#navCount').textContent = sc ? '(' + sc + ')' : '';
  $('#medCount').textContent = meds.length ? '(' + meds.length + ')' : '';

  /* alerts */
  reminders = reminders.filter(r => { const d = ds.find(x => x.med.id === r.medId && x.time === r.time); return d && d.status !== 'taken'; });
  const remHtml = reminders.map((r, i) => alertHTML('green', '&#9200;', esc(r.text), esc(r.sub),
    '<button class="sbtn" onclick="markTaken(\'' + r.medId + '\',\'' + r.time + '\')">Mark Taken</button>' +
    '<button class="sbtn" onclick="snooze(\'' + r.medId + '\',\'' + r.time + '\')">Snooze 10 min</button>' +
    '<button class="xbtn" onclick="reminders.splice(' + i + ',1);render()">&#10005;</button>')).join('');
  const safeHtml = ints.map(i => alertHTML('red', '&#9888;&#65039;', 'Drug Interaction Detected', '<b>' + esc(i.title) + ':</b> ' + esc(i.text))).join('') +
    (heat.length ? alertHTML('amber', '&#9728;&#65039;', 'Heatwave Potency Alert (' + temp + '°C Outdoors)',
      '<b>' + esc(heat.map(m => m.name).join(', ')) + '</b> can spoil above 25°C. Store in a refrigerator or cool shaded place.') : '');
  const refillHtml = lowStock().map(m => alertHTML('brown', '&#128722;', 'Refill Reminder',
    m.stock === 0 ? '<b>' + esc(m.name) + '</b> is finished. Please refill it now.' :
    '<b>' + esc(m.name) + '</b> has only ' + esc(stockText(m)) + ' left (about ' + (Math.floor(daysLeft(m) * 10) / 10) + ' days).',
    '<button class="sbtn" onclick="refillPrompt(\'' + m.id + '\')">+ Refill</button>')).join('');
  $('#alertBox').innerHTML = remHtml + safeHtml + refillHtml;
  $('#safetyList').innerHTML = (safeHtml + refillHtml) || alertHTML('green', '&#9989;', 'All clear', 'No drug clashes, heat risks or low-stock items right now.');

  /* snapshot */
  $('#snap').hidden = !(showReport && view === 'daily');
  $('#snap').innerHTML = snapshotHTML();
  $('#snap2').innerHTML = snapshotHTML();

  /* stats */
  $('#stDone').textContent = done + ' / ' + ds.length;
  $('#stAdh').textContent = (ds.length ? Math.round(done / ds.length * 100) : 0) + '%';
  let worst = null;
  if(learned) ds.filter(d => d.status === 'pending').forEach(d => { const p = risk(d.med.id, d.time); if(p >= 0.35 && (!worst || p > worst.p)) worst = {p: p, d: d}; });
  $('#stAdhSub').textContent = worst ? 'AI: likely to miss ' + worst.d.med.name + ' at ' + worst.d.time : 'Keep going steadily';
  $('#stSafe').textContent = sc ? sc + (sc === 1 ? ' Alert' : ' Alerts') : 'Clear';
  $('#stSafeSub').textContent = nHeat + ' heat-sensitive item(s)';

  /* today's timeline */
  $('#presCount').textContent = meds.length + (meds.length === 1 ? ' Prescription' : ' Prescriptions');
  let tl = ds.map(d => {
    const m = d.med, low = daysLeft(m) <= 3;
    let tags = '';
    if(isHeat(m.name)) tags += '<span class="tag cool">&#10052;&#65039; Cool Storage (&lt;25&deg;C)</span>';
    tags += '<span class="tag">&#128266; Voice Enabled</span>';
    tags += '<span class="tag ' + (low ? 'low' : '') + '">&#128230; ' + esc(stockText(m)) + ' left' + (low ? ' • Refill soon' : '') + '</span>';
    tags += '<button class="tag" type="button" onclick="refillPrompt(\'' + m.id + '\')">+ Refill</button>';
    if(d.status === 'pending' && learned){
      const p = risk(m.id, d.time);
      if(p >= 0.35) tags += '<span class="tag risk">&#129302; High miss risk</span>';
      else if(p >= 0.18) tags += '<span class="tag warn">&#129302; Medium miss risk</span>';
    }
    if(d.status === 'missed') tags += '<span class="tag risk">Missed</span>';
    const btn = d.status === 'taken'
      ? '<button class="btn-taken" title="Click to undo" onclick="undoTaken(\'' + m.id + '\',\'' + d.time + '\')">&#10003; Taken &middot; Undo</button>'
      : '<button class="btn-mark" onclick="markTaken(\'' + m.id + '\',\'' + d.time + '\')">Mark Taken</button>';
    return '<div class="item ' + (d.status === 'taken' ? 'done' : '') + '"><div class="ic">' + (d.status === 'taken' ? '&#10003;' : formOf(m).icon) + '</div>' +
      '<div class="im"><div class="iname">' + esc(m.name) + '</div><div class="isub">' + esc(m.info || '') + '</div>' +
      '<div class="isched">&#9200; Scheduled for ' + d.time + '</div><div class="tags">' + tags + '</div></div>' +
      '<div class="ib"><button class="ib-s" title="Read aloud" onclick="readAloud(\'' + m.id + '\',\'' + d.time + '\')">&#128266;</button>' + btn +
      '<button class="ib-x" title="Delete this medicine" onclick="removeMed(\'' + m.id + '\')">&#128465;&#65039;</button></div></div>';
  }).join('');
  if(!ds.length) tl = '<div class="empty">No doses scheduled today. Tap the blue + button to add a medicine, or say "add paracetamol 500 mg at 9 pm".</div>';
  const idle = meds.filter(m => !ds.some(d => d.med.id === m.id));
  if(idle.length) tl += '<div class="later"><div class="lt">NOT DUE TODAY</div>' + idle.map(m => {
    const nd = nextDose(m);
    return '<div class="lrow"><span><b>' + esc(m.name) + '</b></span><span class="sub">' + (nd ? 'Next: ' + dayLabel(nd) + ' at ' + fmt12(nd.t) : 'No upcoming dose') + '</span></div>';
  }).join('') + '</div>';
  $('#timeline').innerHTML = tl;

  /* My Medicines page */
  sel = new Set(Array.from(sel).filter(id => meds.some(m => m.id === id)));
  $('#medsCount').textContent = meds.length + (meds.length === 1 ? ' medicine' : ' medicines');
  $('#medsList').innerHTML = meds.length ? meds.map(medRow).join('') : '<div class="empty">No medicines yet. Tap "+ Add Medicine".</div>';
  $('#delSel').textContent = 'Delete selected (' + sel.size + ')';
  $('#delSel').disabled = !sel.size;
  $('#selAll').checked = meds.length > 0 && sel.size === meds.length;

  /* safety page */
  const hl = meds.filter(m => isHeat(m.name));
  $('#heatList').innerHTML = hl.length ? hl.map(m => '<div class="srow"><b>' + esc(m.name) + '</b><span class="tag cool">&#10052;&#65039; Keep below 25&deg;C</span></div>').join('') : '<div class="empty">No heat-sensitive medicines in your list.</div>';
  $('#stockList').innerHTML = meds.length ? meds.map(m => {
    const dl = daysLeft(m);
    return '<div class="srow"><span><b>' + esc(m.name) + '</b> <span style="color:var(--mut)">' + esc(stockText(m)) + ' left (about ' + (Math.floor(dl * 10) / 10) + ' days)</span></span>' +
      (dl <= 3 ? '<span class="tag low">Refill soon</span>' : '<span class="tag">Stock OK</span>') + '</div>';
  }).join('') : '<div class="empty">No medicines yet.</div>';

  renderInsights(risk, learned);
}
function renderInsights(risk, learned){
  if(!learned){
    $('#insights').innerHTML = '<div class="empty">The model needs at least 6 dose records to start learning. Use CarePulse for a few days or tap "Reset demo data".</div>';
    return;
  }
  const taken = log.filter(l => l.status === 'taken').length;
  let bars = '', days = '';
  for(let i = 6; i >= 0; i--){
    const d = new Date(Date.now() - i * 86400000), ds = dstr(d);
    const e = log.filter(l => l.date === ds), t = e.filter(l => l.status === 'taken').length;
    const pct = e.length ? Math.round(t / e.length * 100) : 0;
    bars += '<div class="bar" style="height:' + Math.max(pct, 3) + '%"><span>' + (e.length ? pct + '%' : '-') + '</span></div>';
    days += '<div>' + DAYN[d.getDay()] + '</div>';
  }
  const slots = ['morning', 'afternoon', 'night'].map(b => {
    const c = risk.counts[b], p = Math.round(risk.slot(b) * 100);
    return c ? '<div class="srow"><span style="text-transform:capitalize"><b>' + b + '</b> doses</span><span>' + p + '% chance of a miss ' +
      (p >= 35 ? '<span class="tag risk">High</span>' : p >= 18 ? '<span class="tag warn">Medium</span>' : '<span class="tag">Low</span>') + '</span></div>' : '';
  }).join('');
  $('#insights').innerHTML = '<div><b>' + Math.round(taken / log.length * 100) + '%</b> overall adherence from ' + log.length + ' recorded doses</div>' +
    '<div class="bars">' + bars + '</div><div class="days">' + days + '</div><div style="margin-top:16px">' + slots + '</div>' +
    '<div style="font-size:12px;color:var(--mut);margin-top:10px">A smoothed probability model learns your history for each medicine and time of day, then flags doses you are likely to miss.</div>';
}

/* ===================== start ===================== */
let unlocked = false;
document.addEventListener('click', () => {
  if(unlocked) return; unlocked = true;      // browsers only allow sound and speech after the first click
  try{ actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); }catch(e){}
  if(voiceOn && 'speechSynthesis' in window){ try{ const u = new SpeechSynthesisUtterance('CarePulse voice is ready'); u.lang = 'en-IN'; speechSynthesis.speak(u); }catch(e){} }
}, {once: true});
document.addEventListener('visibilitychange', () => { if(!document.hidden){ document.title = baseTitle; tick(); } });
try{ if(navigator.permissions) navigator.permissions.query({name: 'notifications'}).then(p => { p.onchange = () => render(); }).catch(() => {}); }catch(e){}
initSW(); initAddForm();
render(); tick();
setInterval(tick, 5000);