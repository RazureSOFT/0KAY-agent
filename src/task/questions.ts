import {randomUUID} from 'crypto';
export class QuestionManager {
 private pending=new Map<string,{value:any;resolve:(answer:string)=>void;reject:(error:Error)=>void}>();
 list(){return [...this.pending.values()].map(item=>item.value)}
 answer(id:string,answer:string){const item=this.pending.get(id);if(!item)return false;item.resolve(answer);return true}
 async ask(taskId:string,sessionId:string,args:Record<string,any>,signal:AbortSignal){
  signal.throwIfAborted();if(typeof args.question!=='string'||!args.question.trim())throw new Error('question required');
  const options=Array.isArray(args.options)?args.options.filter((item:any)=>typeof item==='string').slice(0,20):[];
  const id=randomUUID();return new Promise<string>((resolve,reject)=>{
   const clean=()=>{signal.removeEventListener('abort',abort);this.pending.delete(id)};
   const abort=()=>{clean();reject(signal.reason||new Error('Task cancelled'))};
   this.pending.set(id,{value:{id,task_id:taskId,session_id:sessionId,question:args.question,options,created_at:new Date().toISOString()},resolve:answer=>{clean();resolve(answer)},reject});
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
 }
}
