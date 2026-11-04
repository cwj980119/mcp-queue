import * as oidc from 'openid-client';
import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { IdentityStore, type LoginProfile, type BrowserSession } from './identity.js';
import { AppError } from './types.js';

export type AuthMode='oidc'|'development'|'legacy';
export type AuthSettings={mode:AuthMode;publicUrl:string;issuer?:string;discoveryUrl?:string;clientId?:string;clientSecret?:string;
  clientAuth:'client_secret_basic'|'client_secret_post'|'none';scopes:string;redirectUri?:string;prompt?:string;
  autoLogin:boolean;allowLocalHttp:boolean;sessionSeconds:number;keyDays:number;deviceIdClaim?:string;deviceNameClaim?:string};
export function authSettings(env:NodeJS.ProcessEnv=process.env):AuthSettings {
  const mode=z.enum(['oidc','development','legacy']).default('oidc').parse(env.AUTH_MODE||undefined);
  return {mode,publicUrl:env.QUEUE_SERVER_URL??'',issuer:env.OIDC_ISSUER_URL||undefined,discoveryUrl:env.OIDC_DISCOVERY_URL||undefined,
    clientId:env.OIDC_CLIENT_ID||undefined,clientSecret:env.OIDC_CLIENT_SECRET||undefined,
    clientAuth:z.enum(['client_secret_basic','client_secret_post','none']).default('client_secret_basic').parse(env.OIDC_TOKEN_AUTH_METHOD||undefined),
    scopes:[...new Set(['openid','profile','email',...(env.OIDC_SCOPES??'').split(/\s+/).filter(Boolean)])].join(' '),
    redirectUri:env.OIDC_REDIRECT_URI||undefined,prompt:env.OIDC_PROMPT||undefined,autoLogin:env.OIDC_AUTO_LOGIN!=='false',
    allowLocalHttp:env.OIDC_ALLOW_HTTP_LOCALHOST==='true',
    sessionSeconds:z.coerce.number().int().min(60).max(604800).default(28800).parse(env.SESSION_TTL_SECONDS||undefined),
    keyDays:z.coerce.number().int().min(1).max(3650).default(90).parse(env.DEVICE_KEY_TTL_DAYS||undefined),
    deviceIdClaim:env.OIDC_DEVICE_ID_CLAIM||undefined,deviceNameClaim:env.OIDC_DEVICE_NAME_CLAIM||undefined};
}
function loopback(url:URL){return ['localhost','127.0.0.1','[::1]'].includes(url.hostname);}
function transportUrl(value:string,allowHttp:boolean){const url=new URL(value);
  if(url.username||url.password||url.hash||!(url.protocol==='https:'||(allowHttp&&url.protocol==='http:'&&loopback(url))))throw new Error('OIDC endpoints require HTTPS (HTTP is limited to explicitly enabled localhost tests).');return url;}
function cookie(req:Request,name:string):string|undefined {
  const part=req.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(`${name}=`));
  return part?.slice(name.length+1);
}
function claimText(claims:Record<string,unknown>,name:string|undefined):string|undefined {
  if(!name)return;let value:unknown=claims[name];
  if(value===undefined){value=claims;for(const key of name.split('.'))value=value&&typeof value==='object'?(value as Record<string,unknown>)[key]:undefined;}
  return typeof value==='string'&&value.length>0?value.slice(0,250):undefined;
}
export class BrowserAuth {
  readonly sessionCookie:string;readonly flowCookie:string;readonly ready:boolean;readonly missing:string[]=[];
  readonly publicUrl:URL;readonly redirect:URL;private configuration?:Promise<oidc.Configuration>;
  constructor(readonly identities:IdentityStore,readonly settings:AuthSettings){
    let valid=true;let publicUrl:URL;
    try{publicUrl=new URL(settings.publicUrl);if(publicUrl.username||publicUrl.password||publicUrl.pathname!=='/'||publicUrl.search||publicUrl.hash)throw new Error();}
    catch{publicUrl=new URL('http://localhost');valid=false;this.missing.push('QUEUE_SERVER_URL');}
    this.publicUrl=publicUrl;this.redirect=new URL(settings.redirectUri??'/auth/callback',publicUrl);
    if(this.redirect.origin!==publicUrl.origin||this.redirect.search||this.redirect.hash){valid=false;this.missing.push('OIDC_REDIRECT_URI');}
    if(settings.mode==='oidc'){
      if(!settings.issuer)this.missing.push('OIDC_ISSUER_URL');
      if(!settings.clientId)this.missing.push('OIDC_CLIENT_ID');
      if(settings.clientAuth!=='none'&&!settings.clientSecret)this.missing.push('OIDC_CLIENT_SECRET');
      try{transportUrl(publicUrl.href,settings.allowLocalHttp);if(settings.issuer)transportUrl(settings.issuer,settings.allowLocalHttp);
        if(settings.discoveryUrl)transportUrl(settings.discoveryUrl,settings.allowLocalHttp);}
      catch{valid=false;this.missing.push('HTTPS_OR_EXPLICIT_LOCALHOST_TEST');}
    }
    if(settings.mode==='development'&&!loopback(publicUrl))throw new Error('Development login is restricted to a localhost server URL.');
    this.ready=valid&&this.missing.length===0;
    const secure=publicUrl.protocol==='https:';this.sessionCookie=secure?'__Host-mq_session':'mq_session';this.flowCookie=secure?'__Host-mq_oidc_flow':'mq_oidc_flow';
  }
  browser(req:Request){return this.identities.session(cookie(req,this.sessionCookie));}
  sessionToken(req:Request){return cookie(req,this.sessionCookie);}
  checkWrite(req:Request,session:BrowserSession){
    if(req.headers.origin&&req.headers.origin!==this.publicUrl.origin)throw new AppError(403,'Origin rejected');
    if(req.headers['x-csrf-token']!==session.csrf)throw new AppError(403,'CSRF token required');
  }
  private setSession(req:Request,res:Response,profile:LoginProfile){
    this.identities.logout(this.sessionToken(req));
    const person=this.identities.upsert(profile),session=this.identities.newSession(person,profile,this.settings.sessionSeconds);
    res.cookie(this.sessionCookie,session.token,{httpOnly:true,sameSite:'lax',secure:this.publicUrl.protocol==='https:',path:'/',maxAge:this.settings.sessionSeconds*1000});
    return person;
  }
  private async config():Promise<oidc.Configuration>{
    if(!this.ready||this.settings.mode!=='oidc')throw new AppError(503,'OIDC configuration is incomplete');
    if(!this.configuration)this.configuration=(async()=>{
      const clientAuth=this.settings.clientAuth==='none'?oidc.None():this.settings.clientAuth==='client_secret_post'?oidc.ClientSecretPost(this.settings.clientSecret):oidc.ClientSecretBasic(this.settings.clientSecret);
      const config=await oidc.discovery(new URL(this.settings.discoveryUrl??this.settings.issuer!),this.settings.clientId!,
        {token_endpoint_auth_method:this.settings.clientAuth},clientAuth,{timeout:15,...(this.settings.allowLocalHttp?{execute:[oidc.allowInsecureRequests]}:{})});
      const metadata=config.serverMetadata();
      if(metadata.issuer!==this.settings.issuer)throw new Error('OIDC issuer mismatch');
      for(const endpoint of [metadata.issuer,metadata.authorization_endpoint,metadata.token_endpoint,metadata.jwks_uri,metadata.userinfo_endpoint])
        if(endpoint)transportUrl(endpoint,this.settings.allowLocalHttp);
      oidc.enableNonRepudiationChecks(config);
      return config;
    })().catch(error=>{this.configuration=undefined;throw error;});
    return this.configuration;
  }
  routes(app:Express){
    app.get('/auth/config',(_req,res)=>res.json({mode:this.settings.mode,ready:this.ready,missing:this.missing,autoLogin:this.settings.autoLogin}));
    app.get('/auth/session',(req,res)=>{const session=this.ready?this.browser(req):undefined;
      if(!session)return res.status(401).json({error:'Login required'});
      res.json({actor:session.actor,csrf:session.csrf,expiresAt:session.expiresAt,deviceName:session.deviceName});});
    app.get('/auth/login',async(req,res)=>{
      try{
        const config=await this.config(),state=oidc.randomState(),verifier=oidc.randomPKCECodeVerifier(),nonce=oidc.randomNonce(),browser=randomBytes(32).toString('base64url');
        this.identities.createFlow(state,browser,verifier,nonce);
        res.cookie(this.flowCookie,browser,{httpOnly:true,sameSite:'lax',secure:this.publicUrl.protocol==='https:',path:'/',maxAge:300000});
        const parameters={redirect_uri:this.redirect.href,scope:this.settings.scopes,response_type:'code',state,nonce,
          code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',...(this.settings.prompt?{prompt:this.settings.prompt}:{})};
        res.redirect(oidc.buildAuthorizationUrl(config,parameters).href);
      }catch{res.redirect('/?auth_error=configuration');}
    });
    app.get(this.redirect.pathname,async(req,res)=>{
      try{
        const state=z.string().max(200).parse(req.query.state),flow=this.identities.takeFlow(state,cookie(req,this.flowCookie));
        res.clearCookie(this.flowCookie,{path:'/',secure:this.publicUrl.protocol==='https:',httpOnly:true,sameSite:'lax'});
        if(!flow)throw new Error('Invalid or expired login flow');
        const config=await this.config();
        const tokens=await oidc.authorizationCodeGrant(config,new URL(req.originalUrl,this.publicUrl),{pkceCodeVerifier:flow.verifier,expectedState:state,expectedNonce:flow.nonce,idTokenExpected:true});
        const claims=tokens.claims();if(!claims?.sub)throw new Error('Missing subject');
        const userInfo=config.serverMetadata().userinfo_endpoint?await oidc.fetchUserInfo(config,tokens.access_token,claims.sub):{};
        const profile={...claims,...userInfo} as Record<string,unknown>;
        this.setSession(req,res,{issuer:this.settings.issuer!,sub:claims.sub,
          name:(claimText(profile,'name')??claimText(profile,'preferred_username')??claimText(profile,'email')??claims.sub).slice(0,100),
          email:claimText(profile,'email'),emailVerified:profile.email_verified===true,
          deviceIdentity:claimText(profile,this.settings.deviceIdClaim),deviceName:claimText(profile,this.settings.deviceNameClaim)});
        res.redirect('/');
      }catch{res.redirect('/?auth_error=login_failed');}
    });
    app.post('/auth/development',(req,res,next)=>{
      if(this.settings.mode!=='development'||!this.ready)return res.status(404).end();
      try{
        if(req.headers.origin!==this.publicUrl.origin||!req.is('application/json'))throw new AppError(403,'Origin rejected');
        const input=z.object({name:z.string().trim().min(1).max(100),email:z.string().email().max(200)}).strict().parse(req.body);
        this.setSession(req,res,{issuer:'urn:mcp-queue:development',sub:input.email.toLowerCase(),name:input.name,email:input.email,emailVerified:false});
        res.json({ok:true});
      }catch(error){next(error);}
    });
    app.post('/auth/logout',(req,res,next)=>{
      try{const session=this.browser(req);if(!session)throw new AppError(401,'Login required');this.checkWrite(req,session);
        this.identities.logout(this.sessionToken(req));res.clearCookie(this.sessionCookie,{path:'/',httpOnly:true,sameSite:'lax',secure:this.publicUrl.protocol==='https:'});res.json({ok:true});}
      catch(error){next(error);}
    });
  }
}
