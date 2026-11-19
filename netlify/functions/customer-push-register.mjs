// Kompatibilität: alte Kundenseite → shop-api push-register.
import shopApi from './shop-api.mjs';
export default async req=>{
 if(req.method!=='POST')return Response.json({error:'Methode nicht erlaubt'},{status:405});
 let b={};try{b=await req.json()}catch{}
 return shopApi(new Request(req.url,{method:'POST',headers:req.headers,body:JSON.stringify({action:'push-register',orderId:b.orderId,token:b.token,subscription:b.subscription})}));
};
