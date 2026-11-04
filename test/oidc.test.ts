import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { createClientApp } from '../src/client.js';
import { authSettings } from '../src/oidc.js';
import { readConnection } from '../src/connection.js';
import { createSchema } from '../src/types.js';

const listen=(server:ReturnType<typeof createServer>)=>new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
async function unusedAddress(){const server=createServer();const url=await listen(server);await new Promise<void>(done=>server.close(()=>done()));return url;}
const cookie=(response:Response,name='mq_session')=>response.headers.getSetCookie().find(value=>value.startsWith(name+'='))?.split(';')[0]??'';
const hash=(value:string)=>createHash('sha256').update(value).digest('base64url');

async function mockProvider(){
  const keys=await generateKeyPair('RS256'),wrong=await generateKeyPair('RS256');const jwk={...await exportJWK(keys.publicKey),kid:'fixture',alg:'RS256',use:'sig'};
  const app=express();app.use(express.urlencoded({extended:false}));const http=createServer(app);const issuer=await listen(http);
  let subject='employee-42',name='개발 사용자',email='person@corp.test',fault='';
  const codes=new Map<string,URLSearchParams>();
  app.get('/.well-known/openid-configuration',(_req,res)=>res.json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',userinfo_endpoint:issuer+'/userinfo',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_basic'],code_challenge_methods_supported:['S256']}));
  app.get('/jwks',(_req,res)=>res.json({keys:[jwk]}));
  app.get('/authorize',(req,res)=>{
    const params=new URL(req.originalUrl,issuer).searchParams;assert.equal(params.get('code_challenge_method'),'S256');
    assert.deepEqual(new Set(params.get('scope')!.split(' ')),new Set(['openid','profile','email']));
    const code=randomUUID();codes.set(code,params);const next=new URL(params.get('redirect_uri')!);next.searchParams.set('state',params.get('state')!);next.searchParams.set('code',code);res.redirect(next.href);
  });
  app.post('/token',async(req,res)=>{
    const credentials=Buffer.from(req.headers.authorization!.slice(6),'base64').toString().split(':').map(value=>decodeURIComponent(value.replaceAll('+',' ')));
    assert.deepEqual(credentials,['test-client','test-secret']);
    const params=codes.get(req.body.code);codes.delete(req.body.code);
    if(!params||hash(req.body.code_verifier)!==params.get('code_challenge')||req.body.redirect_uri!==params.get('redirect_uri'))return res.status(400).json({error:'invalid_grant'});
    const idToken=await new SignJWT({nonce:fault==='nonce'?'bad-nonce':params.get('nonce'),name,email,email_verified:true,pc:{id:'managed-pc-42',name:'개발 노트북'}})
      .setProtectedHeader({alg:'RS256',kid:'fixture'}).setSubject(subject).setIssuer(issuer).setAudience(fault==='audience'?'other-client':'test-client').setIssuedAt().setExpirationTime('5m').sign(fault==='signature'?wrong.privateKey:keys.privateKey);
    res.json({access_token:'fixture-access',token_type:'Bearer',expires_in:300,id_token:idToken});
  });
  app.get('/userinfo',(req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-access');res.json({sub:fault==='userinfo-sub'?'someone-else':subject,name,email,email_verified:true});});
  return {issuer,set(value:{sub?:string;name?:string;email?:string;fault?:string}){subject=value.sub??subject;name=value.name??name;email=value.email??email;fault=value.fault??'';},close:()=>new Promise<void>(done=>{http.close(()=>done());http.closeIdleConnections();})};
}

test('OIDC code + PKCE login registers stable identities; self-service PC keys have separate roles, fencing, persistence and revocation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-oidc-')),provider=await mockProvider(),url=await unusedAddress();
  const settings=authSettings({AUTH_MODE:'oidc',QUEUE_SERVER_URL:url,OIDC_ISSUER_URL:provider.issuer,OIDC_CLIENT_ID:'test-client',OIDC_CLIENT_SECRET:'test-secret',OIDC_ALLOW_HTTP_LOCALHOST:'true',OIDC_DEVICE_ID_CLAIM:'pc.id',OIDC_DEVICE_NAME_CLAIM:'pc.name'});
  const database=join(dir,'queue.sqlite');let central=createApp({database,authentication:settings});await new Promise<void>(done=>central.http.listen(Number(new URL(url).port),'127.0.0.1',done));
  const call=async(path:string,options:{cookie?:string;csrf?:string;token?:string;body?:unknown;status?:number;origin?:string}={})=>{
    const response=await fetch(url+path,{method:options.body===undefined?'GET':'POST',headers:{Connection:'close','Content-Type':'application/json',...(options.cookie?{Cookie:options.cookie}:{}),...(options.csrf?{'X-CSRF-Token':options.csrf}:{}),...(options.token?{Authorization:`Bearer ${options.token}`} :{}),...(options.origin?{Origin:options.origin}:{})},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
    assert.equal(response.status,options.status??200,path);return response.json() as Promise<any>;
  };
  const login=async(fault='',replay=false)=>{
    provider.set({fault});const start=await fetch(url+'/auth/login',{redirect:'manual'});assert.equal(start.status,302);
    const flowCookie=cookie(start,'mq_oidc_flow');assert(flowCookie);assert.match(start.headers.get('set-cookie')!,/HttpOnly/);
    const authorize=await fetch(start.headers.get('location')!,{redirect:'manual'});const callback=authorize.headers.get('location')!;
    if(replay){
      const tampered=new URL(callback);tampered.searchParams.set('state','invalid-state');
      for(const [target,headers] of [[tampered.href,{Cookie:flowCookie}],[callback,{}]] as const){
        const denied=await fetch(target,{redirect:'manual',headers});assert.equal(denied.headers.get('location'),'/?auth_error=login_failed');assert.equal(cookie(denied),'');
      }
    }
    const result=await fetch(callback,{redirect:'manual',headers:{Cookie:flowCookie}});
    assert.equal(result.headers.get('location'),fault?'/?auth_error=login_failed':'/');
    if(replay){const again=await fetch(callback,{redirect:'manual',headers:{Cookie:flowCookie}});assert.equal(again.headers.get('location'),'/?auth_error=login_failed');}
    return cookie(result);
  };
  try{
    assert.equal((await call('/auth/config')).mode,'oidc');await call('/api/me',{status:401});
    const firstCookie=await login('',true),first=await call('/auth/session',{cookie:firstCookie});assert.equal(first.deviceName,'개발 노트북');
    const firstId=first.actor.id;assert(firstId.startsWith('u_'));
    provider.set({name:'변경된 이름',email:'new@corp.test'});const currentCookie=await login(),session=await call('/auth/session',{cookie:currentCookie});assert.equal(session.actor.id,firstId);assert.equal(session.actor.name,'변경된 이름');
    assert.equal((await call('/api/users',{cookie:currentCookie})).length,1);
    const human={cookie:currentCookie,csrf:session.csrf};
    await call('/api/devices',{cookie:currentCookie,body:{label:'PC'},status:403});
    await call('/api/devices',{...human,origin:'https://untrusted.invalid',body:{label:'PC'},status:403});
    const bundle=readConnection(JSON.stringify(await call('/api/devices',{...human,body:{label:'내 노트북'},status:201})));
    assert.equal(bundle.version,2);assert.equal(bundle.humanToken,undefined);assert.equal(bundle.serverUrl,url);assert.equal(bundle.userId,firstId);
    assert.equal((await call('/api/me',{token:bundle.agentToken})).role,'agent');assert.equal((await call('/api/me',{token:bundle.workerToken})).role,'worker');
    await call('/api/devices',{token:bundle.workerToken,body:{label:'forbidden'},status:403});
    const deviceList=await call('/api/devices',human);assert.equal(deviceList[0].oidcDeviceIdentity,'managed-pc-42');assert(!JSON.stringify(deviceList).includes(bundle.agentToken));
    assert.equal((central.store.db.prepare('SELECT hash FROM device_keys').all() as any[]).some(row=>row.hash===bundle.agentToken),false);
    const bundle2=await call('/api/devices',{...human,body:{label:'다른 PC'},status:201});
    provider.set({sub:'employee-43',name:'검토자',email:'same@corp.test'});const secondCookie=await login(),second=await call('/auth/session',{cookie:secondCookie});
    assert.notEqual(second.actor.id,firstId);
    await call(`/api/devices/${bundle.deviceId}/revoke`,{cookie:secondCookie,csrf:second.csrf,body:{},status:404});
    const task=await call('/api/requests',{cookie:secondCookie,csrf:second.csrf,body:{recipient:firstId,title:'OIDC 요청',body:'문서 확인',idempotencyKey:randomUUID()},status:201});
    await call(`/api/requests/${task.id}/action`,{token:bundle.agentToken,body:{action:'approve'},status:403});
    await call(`/api/requests/${task.id}/action`,{...human,body:{action:'approve'}});
    const run=await call('/api/worker/claim',{token:bundle.workerToken,body:{}});assert.equal(run.id,task.id);
    await call(`/api/worker/${task.id}/update`,{token:bundle2.workerToken,body:{runId:run.runId,kind:'draft',text:'other PC'},status:403});
    await call(`/api/worker/${task.id}/update`,{token:bundle.workerToken,body:{runId:run.runId,kind:'draft',text:'검토할 초안'}});
    await call(`/api/requests/${task.id}/action`,{...human,body:{action:'publish',text:'최종 회신'}});
    assert.equal((await call(`/api/requests/${task.id}`,{cookie:secondCookie})).result,'최종 회신');
    const local=createClientApp({home:dir,stateDir:join(dir,'client')});const clientUrl=await listen(local.http);
    try{
      const response=await fetch(clientUrl+'/api/import',{method:'POST',headers:{'Content-Type':'application/json','X-Client-Key':local.key},body:JSON.stringify({text:JSON.stringify(bundle)})});assert.equal(response.status,200);
      const open=await fetch(clientUrl+'/api/login',{method:'POST',headers:{'X-Client-Key':local.key}});const data=await open.json() as any;assert.equal(new URL(data.url).hash,'');
    }finally{await local.close();}
    // A connected manager is authenticated with its PC key; revocation must cut its live access too.
    const ws=new WebSocket(url.replace('http:','ws:')+'/events');await new Promise<void>((done,reject)=>{ws.on('open',()=>ws.send(JSON.stringify({type:'auth',token:bundle.workerToken})));ws.once('message',()=>done());ws.once('error',reject);});
    const closed=new Promise<void>(done=>ws.once('close',()=>done()));
    await call(`/api/devices/${bundle.deviceId}/revoke`,{...human,body:{}});await call('/api/me',{token:bundle.workerToken,status:401});
    central.store.onChange(central.store.get(second.actor,task.id));await closed;
    await central.close();central=createApp({database,authentication:settings});await new Promise<void>(done=>central.http.listen(Number(new URL(url).port),'127.0.0.1',done));
    assert.equal((await call('/api/me',{token:bundle2.workerToken})).id,firstId);assert.equal((await call('/auth/session',{cookie:currentCookie})).actor.id,firstId);
    central.store.db.prepare('UPDATE devices SET expiresAt=0 WHERE id=?').run(bundle2.deviceId);await call('/api/me',{token:bundle2.workerToken,status:401});
    for(const fault of ['nonce','audience','signature','userinfo-sub'])assert.equal(await login(fault),'');
    await call('/auth/logout',{...human,body:{}});await call('/auth/session',{cookie:currentCookie,status:401});
    central.store.db.prepare('UPDATE browser_sessions SET expiresAt=0').run();await call('/auth/session',{cookie:secondCookie,status:401});
    // No provider access or ID tokens are stored in any table.
    const dumps=JSON.stringify(['people','devices','browser_sessions','oidc_flows','device_keys'].map(table=>central.store.db.prepare(`SELECT * FROM ${table}`).all()));assert(!dumps.includes('fixture-access'));
  }finally{await central.close();await provider.close();rmSync(dir,{recursive:true,force:true});}
});

test('missing corporate settings fail closed; development login requires explicit localhost mode; bootstrap creates no sample users',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-no-idp-'));const central=createApp({database:join(dir,'queue.sqlite'),authentication:authSettings({QUEUE_SERVER_URL:'https://queue.corp.test'})});const url=await listen(central.http);
  try{
    const config=await (await fetch(url+'/auth/config')).json() as any;assert.equal(config.ready,false);assert(config.missing.includes('OIDC_CLIENT_ID'));
    assert.equal((await fetch(url+'/auth/development',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
    assert.throws(()=>createApp({database:join(dir,'bad.sqlite'),authentication:authSettings({AUTH_MODE:'development',QUEUE_SERVER_URL:'http://192.0.2.1:3000'})}),/localhost/);
    execFileSync(process.execPath,['scripts/bootstrap.mjs'],{env:{...process.env,AUTH_MODE:'oidc',QUEUE_SETUP_DIR:join(dir,'setup'),QUEUE_SERVER_URL:'https://queue.corp.test'},stdio:'pipe'});
    assert(!existsSync(join(dir,'setup','auth.json')));assert.deepEqual(JSON.parse(readFileSync(join(dir,'setup','server-auth','auth.json'),'utf8')),[]);
    assert.equal(readFileSync(join(dir,'setup','server-auth','server-address.txt'),'utf8').trim(),'https://queue.corp.test');
  }finally{await central.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit localhost development login uses the same dynamic user and session APIs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-development-')),url=await unusedAddress();const central=createApp({database:join(dir,'queue.sqlite'),authentication:authSettings({AUTH_MODE:'development',QUEUE_SERVER_URL:url})});await new Promise<void>(done=>central.http.listen(Number(new URL(url).port),'127.0.0.1',done));
  try{
    const body=JSON.stringify({name:'로컬 사용자',email:'local@example.test'});
    assert.equal((await fetch(url+'/auth/development',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.invalid'},body})).status,403);
    const response=await fetch(url+'/auth/development',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body});assert.equal(response.status,200);
    const info=await (await fetch(url+'/auth/session',{headers:{Cookie:cookie(response)}})).json() as any;assert.equal(info.actor.name,'로컬 사용자');
    const a=central.identities.upsert({issuer:'https://idp-a',sub:'1',name:'A',email:'same@example.test'}),b=central.identities.upsert({issuer:'https://idp-b',sub:'1',name:'B',email:'same@example.test'});assert.notEqual(a.id,b.id);
    assert.equal(central.identities.list().length,3);
  }finally{await central.close();rmSync(dir,{recursive:true,force:true});}
});
