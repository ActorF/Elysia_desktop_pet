// Pure gesture recognition in character coordinates; clicks deliberately use
// screen coordinates because the native pet window follows a dragged pointer.
export const HEAD_ZONE = Object.freeze({ x:295, y:195, radiusX:140, radiusY:125 });
export const INTERACTION_LIMITS = Object.freeze({
  clickDistance:6, clickDuration:500, pokeWindow:3000, pokeThreshold:5, pokeCooldown:3000,
});
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const hasScreen = value => Number.isFinite(value?.screenX) && Number.isFinite(value?.screenY);
export function isHeadPoint(x,y) {
  return Number.isFinite(x) && Number.isFinite(y)
    && ((x-HEAD_ZONE.x)/HEAD_ZONE.radiusX)**2+((y-HEAD_ZONE.y)/HEAD_ZONE.radiusY)**2 <= 1;
}

const PART_EXPRESSIONS = Object.freeze({
  head: ['blush','wink','heart','smile'], face: ['blush','wink','heart','smile'], hand: ['blush','wink','heart','smile'],
  body: ['surprise','angry','blush'], legs: ['surprise','angry','blush'], prop: ['smile'],
});

export function createInteractions({onReaction=()=>{},now=clock,random=Math.random}={}) {
  let pressed=null,pokes=[],lastTime=-Infinity,pokeCooldownUntil=-Infinity;
  const timeOf = value => Number.isFinite(value?.now) ? value.now : now();
  function emit(type,expression,duration,time,part) {
    const result={type,expression,duration,now:time,...(part?{part}:{})};onReaction(result);return result;
  }
  function cancel() {pressed=null;pokes=[];}
  function reset() {cancel();pokeCooldownUntil=-Infinity;lastTime=-Infinity;}
  function acceptTime(time) {
    if(!Number.isFinite(time)||time<lastTime)return false;
    lastTime=time;return true;
  }
  function measurePress(value) {
    if(pressed&&hasScreen(value))pressed.maximumDistance=Math.max(pressed.maximumDistance,
      Math.hypot(value.screenX-pressed.screenX,value.screenY-pressed.screenY));
  }
  function pointerDown(value={}) {
    const time=timeOf(value);if(!acceptTime(time))return null;
    if(value.blocked||value.part===null||(value.button??0)!==0||!hasScreen(value)){cancel();return null;}
    pressed={pointerId:value.pointerId??0,screenX:value.screenX,screenY:value.screenY,startedAt:time,
      maximumDistance:0,part:Object.hasOwn(PART_EXPRESSIONS,value.part)?value.part:undefined,
      head:value.part===undefined?isHeadPoint(value.x,value.y):value.part==='head'||value.part==='face'};
    return null;
  }
  function pointerUp(value={}) {
    const time=timeOf(value);if(!acceptTime(time))return null;
    if(value.blocked){cancel();return null;}
    if(!pressed||(value.button??0)!==0||(value.pointerId??0)!==pressed.pointerId)return null;
    measurePress(value);const click=pressed;pressed=null;
    if(!hasScreen(value)||click.maximumDistance>INTERACTION_LIMITS.clickDistance
      ||time-click.startedAt>INTERACTION_LIMITS.clickDuration){pokes=[];return null;}
    if(time<pokeCooldownUntil){pokes=[];return null;}
    pokes=pokes.filter(value=>time-value<=INTERACTION_LIMITS.pokeWindow);
    pokes.push(time);
    if(pokes.length>=INTERACTION_LIMITS.pokeThreshold){pokes=[];pokeCooldownUntil=time+INTERACTION_LIMITS.pokeCooldown;return emit('poke-annoyed','angry',2600,time);}
    // Preserve the upstream three voice groups and fifth-click cooldown.
    // Fine body regions vary only the expression; callers without a part retain
    // the original head/body behavior (including older preview integrations).
    const choices = PART_EXPRESSIONS[click.part];
    if (!choices) return click.head?emit('head-pat','blush',2400,time):emit('poke','surprise',1600,time);
    const draw=Number(random()),index=Math.min(choices.length-1,Math.floor(Math.max(0,Number.isFinite(draw)?draw:0)*choices.length));
    return emit(click.head?'head-pat':'poke',choices[index],1800,time,click.part);
  }
  function sample(value={}) {
    const time=timeOf(value);if(!acceptTime(time))return null;
    if(value.blocked){cancel();return null;}
    measurePress(value);
    // Hover never reacts. Sampling only records a held pointer's maximum screen
    // excursion, including native drags that later return to the starting point.
    return null;
  }
  function snapshot() {
    return {pressed:pressed?{...pressed}:null,pokeCount:pokes.length,pokeCooldownUntil};
  }
  return {sample,pointerMove:sample,pointerDown,pointerUp,cancel,reset,snapshot};
}

// Own only the temporary expression. The caller cancels before applying an
// explicit appearance action; an unexpected external change also wins here.
const EXPRESSIONS=new Set(['blush','angry','sleep','surprise','dizzy','wink','cry','heart','smile','awkward']);
export function createExpressionReaction(state,{onChange=()=>{},now=clock}={}) {
  let active=null;
  function change(expression) {
    if(state.expression===expression)return;
    state.expression=expression;onChange();
  }
  function cancel({restore=true}={}) {
    const previous=active;active=null;
    if(previous&&restore&&state.expression===previous.expression)change(previous.previousExpression);
    return Boolean(previous);
  }
  function react(expression,duration=2400) {
    if(!EXPRESSIONS.has(expression)||!Number.isFinite(duration)||duration<=0)return false;
    const time=now();if(!Number.isFinite(time))return false;
    const previousExpression=active&&state.expression===active.expression?active.previousExpression:state.expression;
    active={expression,previousExpression,expiresAt:time+duration};change(expression);return true;
  }
  function tick(time=now()) {
    if(!active||!Number.isFinite(time))return false;
    if(state.expression!==active.expression){active=null;return false;}
    if(time>=active.expiresAt)return cancel();
    return false;
  }
  const snapshot=()=>active?{...active}:null;
  return {react,cancel,tick,snapshot};
}
