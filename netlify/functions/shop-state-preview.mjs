import {requireStaff} from '../lib/auth.mjs';
// Read-only preview of the public NEBU shop settings. Never writes to production.
export default async function handler(req) {
  if (req.method !== 'GET') return Response.json({error:'Methode nicht erlaubt'},{status:405});
  const auth=await requireStaff(req);
  if (auth.error) return auth.error;
  try {
    const response=await fetch('https://shop.nebusushi.com/api/menu-state',{signal:AbortSignal.timeout(7000),headers:{accept:'application/json'},redirect:'error'});
    if (!response.ok) throw Error('Shop antwortet mit HTTP '+response.status);
    const data=await response.json();
    const status=['auto','open','closed'].includes(data.statusMode)?data.statusMode:'auto';
    const prepTime=typeof data.prepTime==='string'?data.prepTime.slice(0,80):'';
    const soldOut=Array.isArray(data.soldOut)?data.soldOut.filter(v=>typeof v==='string').slice(0,200):[];
    return Response.json({source:'shop.nebusushi.com',mode:'read-only',statusMode:status,prepTime,soldOut},{headers:{'cache-control':'no-store, private','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
  } catch(error) {
    return Response.json({error:'Shop-Einstellungen derzeit nicht erreichbar'},{status:502,headers:{'cache-control':'no-store'}});
  }
}
