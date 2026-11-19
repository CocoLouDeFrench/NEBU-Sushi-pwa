// Kompatibilität für ältere Seiten: leitet an die getrennten APIs weiter.
//  - öffentlich (create/status/inventory) → shop-api
//  - Mitarbeiter (GET, update, inventory-update) → nebu-orders
import shopApi from './shop-api.mjs';
import staffApi from './nebu-orders.mjs';
export default async req=>{
 if(req.method==='GET')return staffApi(req);
 if(req.method!=='POST')return Response.json({error:'Methode nicht erlaubt'},{status:405});
 const raw=await req.text();
 let action='';try{action=JSON.parse(raw).action}catch{}
 const forward=new Request(req.url,{method:'POST',headers:req.headers,body:raw});
 return ['update','inventory-update'].includes(action)?staffApi(forward):shopApi(forward);
};
