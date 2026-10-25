'use strict';

// Time and presence policy only. Audio, windows and operating-system events are
// deliberately outside this module so the same rules can run against a test clock.
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const GROUPS = Object.freeze(['01','02','03','04','05','06','07','08','09','10','11','12']);
const PRIORITY = Object.freeze({'11':100,'10':90,'08':80,'09':80,'03':70,'04':60,'01':50,'02':50,'07':50,'05':40,'06':30});
const REASONS = Object.freeze({
  '01':'06:00–10:00 首次活跃', '02':'18:00–22:00 首次活跃',
  '03':'00:00–03:00 内连续使用满 10 分钟', '04':'午饭 11:30–13:00 / 晚饭 17:30–19:00 首次活跃',
  '05':'离开或锁屏至少 30 分钟，回来后等待 5 秒', '06':'连续使用满 60 分钟，期间没有至少 5 分钟的休息',
  '07':'14:00–16:00 首次活跃', '08':'周五 18:00–23:00 首次活跃',
  '09':'周六或周日 10:00–18:00 首次活跃', '10':'距离上次实际活跃至少 72 小时，回来后等待 5 秒',
  '11':'已设置的生日当天首次活跃', '12':'主动退出桌宠时告别',
});
const finite = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
const pad = value => String(value).padStart(2, '0');
const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
function weekKey(date) {
  const monday = new Date(date.getFullYear(),date.getMonth(),date.getDate());
  monday.setDate(monday.getDate() - (monday.getDay()+6)%7);
  return dayKey(monday);
}
function validBirthday(value) {
  if (typeof value !== 'string' || !/^\d{2}-\d{2}$/.test(value)) return false;
  const [month,day] = value.split('-').map(Number), date = new Date(2024,month-1,day);
  return date.getMonth() === month-1 && date.getDate() === day;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function cleanSaved(saved) {
  saved = object(saved);
  const result = {version:1,lastActiveAt:finite(saved.lastActiveAt),lastAutomaticAt:finite(saved.lastAutomaticAt),
    days:{},handled:{},bags:{},birthdayYears:[],longReturn:null};
  for (const [date,record] of Object.entries(object(saved.days))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    result.days[date] = {total:Math.min(6,Math.floor(finite(record?.total))),groups:{}};
    for (const group of GROUPS) result.days[date].groups[group] = Math.min(6,Math.floor(finite(record?.groups?.[group])));
  }
  for (const [key,value] of Object.entries(object(saved.handled))) {
    if (key.length < 90 && Number.isFinite(value) && value >= 0) result.handled[key] = value;
  }
  for (const group of GROUPS) {
    const values = Array.isArray(saved.bags?.[group]) ? saved.bags[group] : [];
    result.bags[group] = [...new Set(values.filter(id => [1,2,3].some(n => id === `${group}-${n}`)))];
  }
  result.birthdayYears = [...new Set((Array.isArray(saved.birthdayYears)?saved.birthdayYears:[])
    .filter(year => Number.isInteger(year) && year >= 1970 && year <= 9999))];
  if (Number.isFinite(saved.longReturn?.startedAt) && Number.isFinite(saved.longReturn?.sourceActiveAt)) {
    result.longReturn = {startedAt:saved.longReturn.startedAt,sourceActiveAt:saved.longReturn.sourceActiveAt};
  }
  return result;
}

function createVoiceEngine({saved = {}, now = Date.now(), random = Math.random} = {}) {
  const data = cleanSaved(saved);
  // A corrected system clock must not leave greetings muted until a future
  // timestamp catches up. Keep a conservative fresh cooldown and discard a
  // return observation that cannot exist on the corrected clock.
  data.lastAutomaticAt = Math.min(data.lastAutomaticAt,now);
  data.lastActiveAt = Math.min(data.lastActiveAt,now);
  if (data.longReturn?.startedAt > now) data.longReturn = null;
  let startedAt = now, lastObservedAt = now, hadActivity = false;
  let awaySince = null, continuousSince = null, sessionNumber = 0, restHandled = false;
  let welcome = null, reservation = null, sequence = 0;
  const manualBags = {};
  const committedTokens = new Set();

  function prune(time) {
    const cutoff = dayKey(new Date(time - 90*DAY));
    for (const date of Object.keys(data.days)) if (date < cutoff) delete data.days[date];
    for (const [key,timestamp] of Object.entries(data.handled)) if (timestamp < time-90*DAY) delete data.handled[key];
  }
  function historyAllowsThirdBirthday(time) { return data.birthdayYears.some(year => year < new Date(time).getFullYear()); }
  function availableLines(groupId, time, manual) {
    return [1,2,3].filter(n => groupId !== '11' || n !== 3 || manual || historyAllowsThirdBirthday(time))
      .map(n => `${groupId}-${n}`);
  }
  function shuffled(values) {
    const copy = [...values];
    for (let i=copy.length-1;i>0;i--) {
      const value = Number(random()), j = Math.min(i,Math.floor(Math.max(0,Number.isFinite(value)?value:0)*(i+1)));
      [copy[i],copy[j]] = [copy[j],copy[i]];
    }
    return copy;
  }
  function linePlan(groupId, time, manual = false) {
    const eligible = availableLines(groupId,time,manual), source = manual ? manualBags : data.bags;
    const all = [1,2,3].map(n=>`${groupId}-${n}`);
    let remaining = (source[groupId] ?? []).filter(id => all.includes(id));
    if (!remaining.length) remaining = shuffled(all);
    // Preserve birthday line 3 in the bag while temporarily ineligible, so it
    // joins the same cycle once a previous-year birthday has been recorded.
    if (!remaining.some(id=>eligible.includes(id))) remaining = [...shuffled(eligible),...remaining];
    const index = remaining.findIndex(id=>eligible.includes(id)), lineId=remaining[index];
    remaining.splice(index,1);
    return {lineId,remaining};
  }
  function selectLine(groupId, {manual = false, now:time = lastObservedAt} = {}) {
    if (!GROUPS.includes(groupId)) return null;
    const plan = linePlan(groupId,time,manual);
    // Manual group auditions use a separate, ephemeral bag. Direct line auditions
    // do not need this method and never alter automatic rotation or quotas.
    if (manual) manualBags[groupId] = plan.remaining;
    return plan.lineId;
  }
  function resetSession() { continuousSince = null; restHandled = false; }
  function observe(sample) {
    const time = sample.now, idle = finite(sample.idleSeconds,Infinity);
    if (time < lastObservedAt) {
      startedAt = time; awaySince = null; welcome = null; resetSession();
      if (data.lastAutomaticAt > time) data.lastAutomaticAt = time;
      if (data.lastActiveAt > time) data.lastActiveAt = time;
      if (data.longReturn?.startedAt > time) data.longReturn = null;
    }
    // A long gap without presence samples is not proof of continuous computer use.
    if (time-lastObservedAt >= 5*MINUTE) resetSession();
    lastObservedAt = time;
    const unavailable = Boolean(sample.locked || sample.suspended);
    const active = !unavailable && idle < 60;
    if (!active) {
      if (hadActivity && awaySince === null) awaySince = unavailable ? time : Math.max(startedAt,time-idle*1000);
      if (unavailable ? awaySince !== null && time-awaySince >= 5*MINUTE : idle >= 300) resetSession();
      return false;
    }
    const inputAt = time-idle*1000;
    if (awaySince !== null) {
      const awayDuration = time-awaySince;
      if (hadActivity && awayDuration >= 30*MINUTE) welcome = {startedAt:time,key:`05:return:${time}`};
      if (awayDuration >= 5*MINUTE) resetSession();
      awaySince = null;
    }
    if (data.lastActiveAt && inputAt-data.lastActiveAt >= 72*HOUR && !data.longReturn) {
      data.longReturn = {startedAt:time,sourceActiveAt:data.lastActiveAt};
    }
    // Store actual input time, not every polling time. Keeping the app open while
    // idle must never manufacture recent activity or erase a long absence.
    if (inputAt >= startedAt && inputAt > data.lastActiveAt) data.lastActiveAt = inputAt;
    hadActivity = true;
    if (continuousSince === null) { continuousSince = time; sessionNumber++; }
    return true;
  }
  function evaluate(input = {}) {
    const time = Number.isFinite(input.now) ? input.now : Date.now();
    const sample = {...input,now:time};
    const active = observe(sample);
    if (welcome && time-welcome.startedAt >= 2*MINUTE) welcome = null;
    if (data.longReturn && time-data.longReturn.startedAt >= 2*MINUTE) data.longReturn = null;
    if (!active || time-startedAt < 5000 || input.enabled === false || input.dnd || input.fullscreen || input.busy) return null;
    if (data.lastAutomaticAt && time-data.lastAutomaticAt < 20*MINUTE) return null;
    const date = new Date(time), day = dayKey(date), year = date.getFullYear(), weekday = date.getDay();
    const minute = date.getHours()*60 + date.getMinutes();
    const count = data.days[day] ?? {total:0,groups:{}};
    const candidates = [];
    const add = (groupId,key,condition,extra = {}) => {
      if (!condition || Object.hasOwn(data.handled,key)) return;
      if (groupId !== '11' && count.total >= 6) return;
      if ((groupId === '05' || groupId === '06') && (count.groups[groupId]??0) >= 2) return;
      candidates.push({groupId,key,day,year,reason:REASONS[groupId],...extra});
    };
    const inRange = (from,to) => minute >= from && minute < to;
    add('01',`01:${day}`,inRange(360,600));
    add('02',`02:${day}`,inRange(1080,1320) && weekday !== 5);
    const midnight = new Date(year,date.getMonth(),date.getDate()).getTime();
    add('03',`03:${day}`,inRange(0,180) && continuousSince !== null && time-Math.max(midnight,continuousSince) >= 10*MINUTE);
    add('04',`04:${day}:lunch`,inRange(690,780));
    add('04',`04:${day}:dinner`,inRange(1050,1140));
    add('05',welcome?.key,Boolean(welcome) && time-welcome.startedAt >= 5000);
    add('06',`06:session:${startedAt}:${sessionNumber}`,continuousSince !== null && !restHandled && time-continuousSince >= HOUR);
    add('07',`07:${day}`,inRange(840,960));
    add('08',`08:${weekKey(date)}`,weekday === 5 && inRange(1080,1380));
    add('09',`09:${day}`,(weekday === 0 || weekday === 6) && inRange(600,1080));
    add('10',data.longReturn ? `10:return:${data.longReturn.sourceActiveAt}` : null,
      Boolean(data.longReturn) && time-data.longReturn.startedAt >= 5000);
    add('11',`11:${year}`,validBirthday(input.birthday) && input.birthday === `${pad(date.getMonth()+1)}-${pad(date.getDate())}`
      && !data.birthdayYears.includes(year));
    candidates.sort((a,b) => PRIORITY[b.groupId]-PRIORITY[a.groupId]);
    if (!candidates.length) return null;
    const selected = candidates[0], plan = linePlan(selected.groupId,time);
    reservation = {...selected,lineId:plan.lineId,remaining:plan.remaining,token:++sequence,createdAt:time,
      suppressed:candidates.slice(1).map(({groupId,key})=>({groupId,key}))};
    return structuredClone(reservation);
  }
  function consumeEvent(event, time) {
    data.handled[event.key] = time;
    if (event.groupId === '05') welcome = null;
    if (event.groupId === '06') restHandled = true;
    if (event.groupId === '10') data.longReturn = null;
  }
  function commit(candidate, time = lastObservedAt) {
    if (!candidate || candidate.simulation || candidate.manual || committedTokens.has(candidate.token)) return false;
    if (!reservation || candidate.token !== reservation.token || candidate.lineId !== reservation.lineId) return false;
    const selected = reservation;
    if (time-selected.createdAt > 2*MINUTE || time < selected.createdAt) return false;
    committedTokens.add(selected.token);
    reservation = null;
    data.bags[selected.groupId] = [...selected.remaining];
    if (selected.groupId === '12') return true;
    const count = data.days[selected.day] ??= {total:0,groups:{}};
    count.groups[selected.groupId] = (count.groups[selected.groupId] ?? 0)+1;
    if (selected.groupId !== '11') count.total++;
    else if (!data.birthdayYears.includes(selected.year)) data.birthdayYears.push(selected.year);
    data.lastAutomaticAt = time;
    consumeEvent(selected,time);
    for (const event of selected.suppressed) consumeEvent(event,time);
    if (selected.groupId === '08') data.handled[`02:${selected.day}`] = time;
    prune(time);
    return true;
  }
  function farewell({now:time = Date.now(),busy = false,lastPlaybackEndedAt = 0,enabled = true} = {}) {
    if (!enabled || busy || (lastPlaybackEndedAt && time-lastPlaybackEndedAt < 10_000)) return null;
    const plan = linePlan('12',time);
    reservation = {groupId:'12',lineId:plan.lineId,remaining:plan.remaining,reason:REASONS['12'],
      token:++sequence,createdAt:time,suppressed:[]};
    return structuredClone(reservation);
  }
  function exportState() { return structuredClone(data); }
  function simulate(groupId, options = {}) { return simulateVoice(groupId,{...options,random}); }
  return {evaluate,commit,exportState,selectLine,farewell,simulate};
}

// Deterministic presence scenarios use the exact evaluator. They do not change
// system time, wait in real time, or import any real automatic-use history.
function simulateVoice(groupId,{now = Date.now(),random = Math.random} = {}) {
  if (!GROUPS.includes(groupId)) return null;
  const monday = new Date(now); monday.setHours(16,30,0,0);
  monday.setDate(monday.getDate()-(monday.getDay()+6)%7);
  const date = new Date(monday);
  const hours = {'01':[8,0],'02':[20,0],'03':[0,1],'04':[12,0],'05':[16,0],
    '06':[16,0],'07':[14,30],'08':[20,0],'09':[10,30],'10':[16,30],'11':[16,30],'12':[16,30]};
  date.setHours(...hours[groupId],0,0);
  if (groupId === '08') date.setDate(date.getDate()+4);
  if (groupId === '09') date.setDate(date.getDate()+5);
  const start = date.getTime();
  const engine = createVoiceEngine({now:start,random,saved:groupId === '10'?{lastActiveAt:start-73*HOUR}:{}});
  let time = start;
  const sample = (offset,extra={}) => {time=start+offset;return engine.evaluate({now:time,idleSeconds:0,...extra});};
  sample(0);
  let candidate;
  if (groupId === '03' || groupId === '06') {
    const duration = groupId === '03'?10*MINUTE:HOUR;
    for (let elapsed=MINUTE;elapsed<=duration;elapsed+=MINUTE) candidate=sample(elapsed);
  } else if (groupId === '05') {
    sample(MINUTE,{idleSeconds:60});
    sample(31*MINUTE,{idleSeconds:31*60});
    sample(32*MINUTE);
    candidate=sample(32*MINUTE+5000);
  } else if (groupId === '12') candidate=engine.farewell({now:start+5000});
  else candidate=sample(5000,groupId === '11'?{birthday:`${pad(date.getMonth()+1)}-${pad(date.getDate())}`} : {});
  return candidate ? {...candidate,simulation:true,simulatedAt:time,scenario:REASONS[groupId]} : null;
}

module.exports = {createVoiceEngine,simulateVoice,validBirthday,GROUPS,REASONS};
