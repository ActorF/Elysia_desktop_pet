'use strict';
const source = require('../renderer/interaction-catalog.json');
const GROUP_PREFIXES = Object.freeze({ 'head-pat':'H', poke:'P', 'poke-annoyed':'A' });
const INTERACTION_CATALOG = Object.freeze(source.map(line => Object.freeze({ id:line.id, groupId:line.groupId, text:line.text })));
const groups = new Map(Object.keys(GROUP_PREFIXES).map(groupId => [groupId,INTERACTION_CATALOG.filter(line=>line.groupId===groupId)]));
if (INTERACTION_CATALOG.length!==18 || new Set(INTERACTION_CATALOG.map(line=>line.id)).size!==18
  || [...groups].some(([groupId,lines])=>lines.length!==6 || lines.some(line=>
    !new RegExp(`^${GROUP_PREFIXES[groupId]}0[1-6]$`).test(line.id) || typeof line.text!=='string' || !line.text.trim()))) {
  throw new Error('互动台词目录需要三类各六句，且编号与类别一致。');
}

function interactionDuration(text) { return Math.min(4600,Math.max(2400,[...text].length*120+900)); }

// Reserve before opening a caption; consume only after the renderer actually
// presents it. Rejected, replaced or failed requests leave the next line intact.
function createInteractionReplies({random=Math.random}={}) {
  const states=new Map([...groups.keys()].map(groupId=>[groupId,{remaining:[],lastId:null,reservation:null}]));
  let sequence=0;
  function randomIndex(length) {
    const value=Number(random());
    return Math.min(length-1,Math.floor(Math.max(0,Number.isFinite(value)?value:0)*length));
  }
  function fill(groupId,state) {
    const bag=[...groups.get(groupId)];
    for(let index=bag.length-1;index>0;index--) {
      const other=randomIndex(index+1);[bag[index],bag[other]]=[bag[other],bag[index]];
    }
    if(bag[0].id===state.lastId) {
      const other=1+randomIndex(bag.length-1);[bag[0],bag[other]]=[bag[other],bag[0]];
    }
    state.remaining=bag;
  }
  function reserve(groupId) {
    const state=states.get(groupId);if(!state)return null;
    if(!state.remaining.length)fill(groupId,state);
    const line=state.remaining[0];
    const candidate=Object.freeze({...line,duration:interactionDuration(line.text),token:++sequence});
    state.reservation=candidate;return candidate;
  }
  function commit(candidate) {
    const state=states.get(candidate?.groupId);
    if(!state||state.reservation?.token!==candidate?.token||state.remaining[0]?.id!==candidate?.id)return false;
    state.remaining.shift();state.lastId=candidate.id;state.reservation=null;return true;
  }
  function snapshot() {
    return Object.fromEntries([...states].map(([groupId,state])=>[groupId,
      {remaining:state.remaining.map(line=>line.id),lastId:state.lastId}]));
  }
  return {hasGroup:groupId=>states.has(groupId),reserve,commit,snapshot};
}

module.exports={createInteractionReplies,interactionDuration,INTERACTION_CATALOG};
