// In-memory stand-ins for @netlify/database (row lock = mutex) and @netlify/blobs.
export const state={row:{orders:[],migrated:true},blobs:new Map(),commits:0};
let lock=Promise.resolve();
export const database={getDatabase:()=>({
 sql:async()=>[structuredClone(state.row)],
 pool:{connect:async()=>{let release;let held=false;let snapshot=null;
  return {query:async(q,params)=>{
   if(q==='BEGIN')return {};
   if(q.includes('FOR UPDATE')){const prev=lock;let r;lock=new Promise(x=>r=x);await prev;release=r;held=true;snapshot=structuredClone(state.row);return {rows:[snapshot]}}
   if(q.startsWith('UPDATE')){snapshot={orders:JSON.parse(params[0]),migrated:true};return {}}
   if(q==='COMMIT'){state.row=snapshot;state.commits++;if(held){held=false;release()}return {}}
   if(q==='ROLLBACK'){if(held){held=false;release()}return {}}
  },release(){if(held){held=false;release()}}}}}
})};
export const blobs={getStore:name=>({
 get:async(k)=>{const v=state.blobs.get(name+'/'+k);return v===undefined?null:structuredClone(v)},
 setJSON:async(k,v)=>{state.blobs.set(name+'/'+k,structuredClone(v))},set:async(k,v)=>state.blobs.set(name+'/'+k,JSON.parse(v))})};
