// Opt-in, fixed-budget synthetic probe. No router retries, DB, or customer credits.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sharp from 'sharp';
import dotenv from 'dotenv';

const reportPath='docs/IMAGE_EDIT_LIVE_PROVIDER_RESULTS.json';
if(!process.argv.includes('--run'))throw new Error('Explicit --run required: at most four provider inference attempts.');
if(fs.existsSync(reportPath))throw new Error('A live probe report already exists. Refusing another paid run.');
const env=dotenv.parse(fs.readFileSync('.env'));
const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'sentiq-image-edit-live-'));
const source=await sharp({create:{width:256,height:256,channels:4,background:'#ffffff'}})
 .composite([{input:Buffer.from('<svg width="256" height="256"><rect x="22" y="50" width="82" height="140" fill="#e00000"/><circle cx="180" cy="120" r="42" fill="#0066ee"/></svg>')}]).png().toBuffer();
fs.writeFileSync(path.join(outDir,'source.png'),source);
const report={scope:'direct authenticated providers; synthetic shapes only; no SentIQ quota ledger',maxInferenceAttempts:4,automaticRetries:0,startedAt:new Date().toISOString(),results:[],costs:{actualCurrencyCharges:'unconfirmed; numeric usage and reported cost headers recorded when available'}};
const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
save();
const prompt='Change only the red rectangle to green. Keep the blue circle and white background unchanged.';
const polliKey=env.POLLINATIONS_API_KEY||env.FLUX_API_KEY;
const cfSlot=Array.from({length:8},(_,n)=>n+1).find(n=>env[`SENTIQ_CLOUDFLARE_AI_ACCOUNT_ID_${n}`]&&env[`SENTIQ_CLOUDFLARE_AI_API_TOKEN_${n}`]);
async function readBounded(response){
 const chunks=[];let total=0;const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>12*1024*1024){await reader.cancel();throw new Error('response_limit');}chunks.push(value);}}finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
async function probe(label,model,url,init){
 const row={label,requestedModel:model,attempted:true};report.results.push(row);save();
 const started=Date.now();
 try{
  const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(90000)});
  row.status=response.status;row.contentType=response.headers.get('content-type');
  row.modelUsed=response.headers.get('x-model-used');row.modelRequested=response.headers.get('x-model-requested');row.fallbackTarget=response.headers.get('x-fallback-target');
  row.numericUsageHeaders=Object.fromEntries([...response.headers].filter(([k,v])=>/^x-(usage|cost|pollen|pollinations-cost)/.test(k)&&/^\d+(\.\d+)?$/.test(v)));
  const bytes=await readBounded(response);let body;
  if(row.contentType?.includes('json')){try{body=JSON.parse(bytes.toString());}catch{row.invalidJson=true;}}
  if(response.ok){
   const b64=body?.data?.[0]?.b64_json||body?.result?.image;
   const image=b64?Buffer.from(b64,'base64'):bytes;
   const meta=await sharp(image,{limitInputPixels:16*1024*1024,failOn:'warning'}).metadata();
   await sharp(image).raw().toBuffer();
   row.image={format:meta.format,width:meta.width,height:meta.height,hasAlpha:meta.hasAlpha,bytes:image.length,sha256:crypto.createHash('sha256').update(image).digest('hex')};
   row.bodyKeys=body?Object.keys(body):[];row.usage=body?.usage;
   row.bodyModel=typeof body?.model==='string'?body.model:null;
   fs.writeFileSync(path.join(outDir,`${label}.${meta.format==='jpeg'?'jpg':meta.format}`),image);
   row.result='image_decoded';
  }else{
   row.result='http_rejected';row.bodyKeys=body?Object.keys(body):[];
   const code=body?.error?.code??body?.errors?.[0]?.code;
   if(typeof code==='number'||(typeof code==='string'&&/^[\w.-]{1,80}$/.test(code)))row.errorCode=code;
  }
 }catch{row.result='timeout_transport_or_decode_failure';row.upstreamOutcome='indeterminate';}
 row.durationMs=Date.now()-started;save();console.log(JSON.stringify(row));
}
if(cfSlot){
 const form=new FormData();form.set('prompt',prompt);form.set('input_image_0',new Blob([source],{type:'image/png'}),'source.png');form.set('width','256');form.set('height','256');form.set('seed','173802');
 await probe('cloudflare-reference','@cf/black-forest-labs/flux-2-klein-4b',`https://api.cloudflare.com/client/v4/accounts/${env[`SENTIQ_CLOUDFLARE_AI_ACCOUNT_ID_${cfSlot}`]}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`,{method:'POST',headers:{Authorization:`Bearer ${env[`SENTIQ_CLOUDFLARE_AI_API_TOKEN_${cfSlot}`]}`},body:form});
}else report.results.push({label:'cloudflare-reference',attempted:false,result:'credentials_missing'});
if(polliKey){
 const headers={Authorization:`Bearer ${polliKey}`};const common={prompt,size:'512x512',quality:'low',seed:173802,response_format:'b64_json',n:1};
 await probe('pollinations-gpt-json','openai/gpt-image-2','https://gen.pollinations.ai/v1/images/edits',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({...common,model:'openai/gpt-image-2',image:`data:image/png;base64,${source.toString('base64')}`})});
 for(const [label,model]of [['pollinations-gpt-multipart','openai/gpt-image-2'],['pollinations-mai-multipart','microsoft/mai-image-2.6']]){
  const form=new FormData();for(const [k,v]of Object.entries({...common,model}))form.set(k,String(v));form.set('image',new Blob([source],{type:'image/png'}),'source.png');
  await probe(label,model,'https://gen.pollinations.ai/v1/images/edits',{method:'POST',headers,body:form});
 }
}else report.results.push({label:'pollinations',attempted:false,result:'credentials_missing'});
report.completedAt=new Date().toISOString();save();console.log('Synthetic artifacts: '+outDir);
