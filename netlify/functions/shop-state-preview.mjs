// Read-only preview of the public NEBU shop settings. Never writes to production.
export default async function handler(req) {
  if (req.method !== 'GET') return Response.json({error:'Methode nicht erlaubt'},{status:405});
  const key=Netlify.env.get('NEBU_TEST_ADMIN_KEY');
  if (!key || req.headers.get('x-nebu-test-key')!==key) return Response.json({error:'Nur für NEBU-Mitarbeiter'},{status:403});
  try {
    const response=await fetch('https://shop.nebusushi.com/api/menu-state',{signal:AbortSignal.timeout(7000),headers:{accept:'application/json'},redirect:'error'});
    if (!response.ok) throw Error('Shop antwortet mit HTTP '+response.status);
    const data=await response.json();
    const status=['auto','open','closed'].includes(data.statusMode)?data.statusMode:'auto';
    const prepTime=typeof data.prepTime==='string'?data.prepTime.slice(0,80):'';
    const soldOut=Array.isArray(data.soldOut)?data.soldOut.filter(v=>typeof v==='string').slice(0,200):[];
    return Response.json({source:'shop.nebusushi.com',mode:'read-only',statusMode:status,prepTime,soldOut},{headers:{'cache-control':'no-store'}});
  } catch(error) {
    return Response.json({error:'Shop-Einstellungen derzeit nicht erreichbar: '+error.message},{status:502,headers:{'cache-control':'no-store'}});
  }
}
