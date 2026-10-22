import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
const cwd='/workspace/review/roast-sandbox';
fs.writeFileSync('/workspace/review/mock-fetch.mjs','globalThis.fetch = async () => new Promise(() => {});\n');
const port=14731;
const child=spawn(process.execPath,['--import','/workspace/review/mock-fetch.mjs','app/server.mjs'],{cwd,env:{...process.env,PORT:String(port),COUNCIL_RUNNER:'api'},stdio:['ignore','pipe','pipe']});
try {
 await once(child.stdout,'data');
 const slow=()=>{
  let resolve;
  const response=new Promise(r=>resolve=r);
  const req=http.request({hostname:'127.0.0.1',port,path:'/api/council',method:'POST',headers:{'content-type':'application/json'}},res=>{
   let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));
  });
  req.write('{"prompt":');return{req,response};
 };
 const a=slow();const b=slow();
 await new Promise(r=>setTimeout(r,100));
 a.req.end('"First sufficiently long decision"}');
 const first=await a.response;
 await new Promise(r=>setTimeout(r,10));
 b.req.end('"Second sufficiently long decision"}');
 const second=await b.response;
 assert.equal(first.status,200);assert.equal(second.status,200);assert.notEqual(first.body.id,second.body.id);
 console.log('CONFIRMED: overlapping POST request bodies bypass single-council guard; both responses 200 with distinct running session IDs. Fetch was mocked; zero API calls.');
} finally {child.kill('SIGTERM');await once(child,'exit');}
