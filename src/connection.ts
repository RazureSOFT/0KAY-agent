import * as grpc from '@grpc/grpc-js';
import {readFileSync} from 'fs';
import {timingSafeEqual} from 'crypto';
import https from 'https';

/** Per-plugin identity (name + service token) issued by Core at registration. */
let pluginName='';
let pluginToken='';
export function setPluginIdentity(name:string,token:string):void{pluginName=name||'';pluginToken=token||''}
export function pluginIdentity():{name:string;token:string}{return{name:pluginName,token:pluginToken}}

/** Core HTTP base, used for the egress proxy (CORE_HTTP_ADDR/CORE_HTTP). */
export function coreHttpBase():string{return (process.env.CORE_HTTP_ADDR||process.env.CORE_HTTP||'http://127.0.0.1:8080').replace(/\/$/,'')}

export function coreCredentials():grpc.ChannelCredentials{return process.env.CORE_TLS_CA?grpc.credentials.createSsl(readFileSync(process.env.CORE_TLS_CA)):grpc.credentials.createInsecure()}
export function coreOptions():grpc.ChannelOptions{return process.env.CORE_TLS_NAME?{'grpc.ssl_target_name_override':process.env.CORE_TLS_NAME,'grpc.default_authority':process.env.CORE_TLS_NAME}:{}}
export function coreMetadata():grpc.Metadata{const m=new grpc.Metadata();const{name,token}=pluginIdentity();if(name&&token){m.set('x-0kay-plugin',name);m.set('authorization',`Bearer ${token}`);return m}const fallback=process.env.CORE_PAIR_TOKEN||process.env.CORE_API_TOKEN;if(fallback)m.set('authorization',`Bearer ${fallback}`);return m}
export function coreHeaders():Record<string,string>{
 const{name,token}=pluginIdentity();
 if(name&&token)return{'X-0KAY-Plugin':name,Authorization:`Bearer ${token}`};
 const fallback=process.env.CORE_PAIR_TOKEN||process.env.CORE_API_TOKEN;
 return fallback?{Authorization:`Bearer ${fallback}`}:{}
}
export function authorized(call:{metadata:{get:(key:string)=>unknown[]}}):boolean{const token=process.env.CORE_PAIR_TOKEN||process.env.CORE_API_TOKEN;if(!token)return true;const actual=Buffer.from(String(call.metadata.get('authorization')[0]||'')),expected=Buffer.from(`Bearer ${token}`);return actual.length===expected.length&&timingSafeEqual(actual,expected)}
export async function coreFetch(url:string,options:RequestInit={}):Promise<Response>{
 if(!process.env.CORE_TLS_CA||!url.startsWith('https:'))return fetch(url,options)
 return new Promise((resolve,reject)=>{
  const request=https.request(url,{method:options.method||'GET',ca:readFileSync(process.env.CORE_TLS_CA!),servername:process.env.CORE_TLS_NAME,headers:Object.fromEntries(new Headers(options.headers)),signal:options.signal||undefined},response=>{
   const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{const headers=new Headers();for(const[key,value]of Object.entries(response.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);resolve(new Response(Buffer.concat(chunks),{status:response.statusCode||500,headers}))})
  });request.on('error',reject);request.end(typeof options.body==='string'?options.body:undefined)
 })
}

/**
 * Perform an outbound HTTP request through Core's egress proxy so it is checked
 * against the plugin's declared egress allow-list. Returns a Response shaped
 * like fetch(), or throws when Core blocks/fails the request.
 */
export async function egressFetch(url:string,options:RequestInit={},timeoutMs=60000):Promise<Response>{
 const headers=new Headers(options.headers);const requestHeaders:Record<string,string>={};headers.forEach((value,key)=>{if(key.toLowerCase()!=='host')requestHeaders[key]=value});
 const method=(options.method||'GET').toUpperCase();
 const body=typeof options.body==='string'?options.body:undefined;
 const res=await coreFetch(`${coreHttpBase()}/api/net/egress`,{
  method:'POST',
  headers:{'Content-Type':'application/json',...coreHeaders()},
  body:JSON.stringify({method,url,headers:requestHeaders,body,timeout_ms:timeoutMs}),
  signal:options.signal,
 });
 const data:any=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(data?.error||`egress HTTP ${res.status}`);
 const outHeaders=new Headers();
 for(const[key,value]of Object.entries(data?.headers||{}))outHeaders.set(key,String(value));
 return new Response(data?.body??'',{status:data?.status||502,headers:outHeaders});
}
