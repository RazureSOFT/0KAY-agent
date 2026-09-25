import * as grpc from '@grpc/grpc-js';
import {readFileSync} from 'fs';
import {timingSafeEqual} from 'crypto';
import https from 'https';
export function coreCredentials():grpc.ChannelCredentials{return process.env.CORE_TLS_CA?grpc.credentials.createSsl(readFileSync(process.env.CORE_TLS_CA)):grpc.credentials.createInsecure()}
export function coreOptions():grpc.ChannelOptions{return process.env.CORE_TLS_NAME?{'grpc.ssl_target_name_override':process.env.CORE_TLS_NAME,'grpc.default_authority':process.env.CORE_TLS_NAME}:{}}
export function coreMetadata():grpc.Metadata{const m=new grpc.Metadata();const token=process.env.CORE_PAIR_TOKEN||process.env.CORE_API_TOKEN;if(token)m.set('authorization',`Bearer ${token}`);return m}
export function coreHeaders():Record<string,string>{const token=process.env.CORE_PAIR_TOKEN||process.env.CORE_API_TOKEN;return token?{Authorization:`Bearer ${token}`}:{}}
export function authorized(call:{metadata:{get:(key:string)=>unknown[]}}):boolean{const token=process.env.CORE_PAIR_TOKEN||process.env.CORE_API_TOKEN;if(!token)return true;const actual=Buffer.from(String(call.metadata.get('authorization')[0]||'')),expected=Buffer.from(`Bearer ${token}`);return actual.length===expected.length&&timingSafeEqual(actual,expected)}
export async function coreFetch(url:string,options:RequestInit={}):Promise<Response>{
 if(!process.env.CORE_TLS_CA||!url.startsWith('https:'))return fetch(url,options)
 return new Promise((resolve,reject)=>{
  const request=https.request(url,{method:options.method||'GET',ca:readFileSync(process.env.CORE_TLS_CA!),servername:process.env.CORE_TLS_NAME,headers:Object.fromEntries(new Headers(options.headers)),signal:options.signal||undefined},response=>{
   const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{const headers=new Headers();for(const[key,value]of Object.entries(response.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);resolve(new Response(Buffer.concat(chunks),{status:response.statusCode||500,headers}))})
  });request.on('error',reject);request.end(typeof options.body==='string'?options.body:undefined)
 })
}
