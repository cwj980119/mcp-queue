import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { tokenHash } from './auth.js';
import { AppError, type Actor } from './types.js';

export type Person={id:string;name:string;email:string|null;emailVerified:boolean;createdAt:number;lastLogin:number};
export type LoginProfile={issuer:string;sub:string;name:string;email?:string;emailVerified?:boolean;deviceIdentity?:string;deviceName?:string};
export type BrowserSession={actor:Actor;csrf:string;expiresAt:number;deviceIdentity:string|null;deviceName:string|null};
export class IdentityStore {
  onUsersChange:()=>void=()=>{};
  constructor(readonly db:DatabaseSync){
    db.exec(`CREATE TABLE IF NOT EXISTS people(
      id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,name TEXT NOT NULL,email TEXT,emailVerified INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,lastLogin INTEGER NOT NULL,UNIQUE(issuer,subject));
      CREATE TABLE IF NOT EXISTS browser_sessions(
        hash TEXT PRIMARY KEY,userId TEXT NOT NULL,csrf TEXT NOT NULL,expiresAt INTEGER NOT NULL,deviceIdentity TEXT,deviceName TEXT);
      CREATE TABLE IF NOT EXISTS oidc_flows(
        stateHash TEXT PRIMARY KEY,browserHash TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(
        id TEXT PRIMARY KEY,userId TEXT NOT NULL,label TEXT NOT NULL,oidcDeviceIdentity TEXT,oidcDeviceName TEXT,
        createdAt INTEGER NOT NULL,lastSeen INTEGER,expiresAt INTEGER NOT NULL,revokedAt INTEGER);
      CREATE INDEX IF NOT EXISTS devices_by_owner ON devices(userId);
      CREATE TABLE IF NOT EXISTS device_keys(
        hash TEXT PRIMARY KEY,userId TEXT NOT NULL,deviceId TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('agent','worker')));
    `);
  }
  upsert(profile:LoginProfile):Person {
    const now=Date.now();
    const row=this.db.prepare(`INSERT INTO people(id,issuer,subject,name,email,emailVerified,createdAt,lastLogin) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(issuer,subject) DO UPDATE SET name=excluded.name,email=excluded.email,emailVerified=excluded.emailVerified,lastLogin=excluded.lastLogin RETURNING *`)
      .get(`u_${randomUUID().replaceAll('-','')}`,profile.issuer,profile.sub,profile.name,profile.email??null,profile.emailVerified?1:0,now,now) as any;
    this.onUsersChange();return this.person(row);
  }
  private person(row:any):Person{return {id:row.id,name:row.name,email:row.email,emailVerified:!!row.emailVerified,createdAt:row.createdAt,lastLogin:row.lastLogin};}
  list():Person[]{return (this.db.prepare('SELECT * FROM people ORDER BY name,id').all() as any[]).map(row=>this.person(row));}
  newSession(person:Person,profile:LoginProfile,ttlSeconds:number){
    const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');const expiresAt=Date.now()+ttlSeconds*1000;
    this.cleanup();
    this.db.prepare('INSERT INTO browser_sessions(hash,userId,csrf,expiresAt,deviceIdentity,deviceName) VALUES(?,?,?,?,?,?)')
      .run(tokenHash(token),person.id,csrf,expiresAt,profile.deviceIdentity??null,profile.deviceName??null);
    return {token,csrf,expiresAt};
  }
  session(token:string|undefined):BrowserSession|undefined {
    if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return;
    const row=this.db.prepare(`SELECT s.*,p.name FROM browser_sessions s JOIN people p ON p.id=s.userId WHERE s.hash=? AND s.expiresAt>?`).get(tokenHash(token),Date.now()) as any;
    if(!row)return;
    return {actor:{id:row.userId,name:row.name,role:'human'},csrf:row.csrf,expiresAt:row.expiresAt,deviceIdentity:row.deviceIdentity,deviceName:row.deviceName};
  }
  logout(token:string|undefined){if(token)this.db.prepare('DELETE FROM browser_sessions WHERE hash=?').run(tokenHash(token));}
  createFlow(state:string,browser:string,verifier:string,nonce:string){
    this.cleanup();this.db.prepare('INSERT INTO oidc_flows(stateHash,browserHash,verifier,nonce,expiresAt) VALUES(?,?,?,?,?)')
      .run(tokenHash(state),tokenHash(browser),verifier,nonce,Date.now()+300000);
  }
  takeFlow(state:string,browser:string|undefined):{verifier:string;nonce:string}|undefined{
    if(!browser||!state||state.length>200||browser.length>200)return;
    return this.db.prepare('DELETE FROM oidc_flows WHERE stateHash=? AND browserHash=? AND expiresAt>? RETURNING verifier,nonce')
      .get(tokenHash(state),tokenHash(browser),Date.now()) as {verifier:string;nonce:string}|undefined;
  }
  issueDevice(session:BrowserSession,label:string,ttlDays:number){
    const id=`pc_${randomUUID().replaceAll('-','')}`,agentToken=randomBytes(32).toString('base64url'),workerToken=randomBytes(32).toString('base64url');
    const now=Date.now(),expiresAt=now+ttlDays*86400000;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('INSERT INTO devices(id,userId,label,oidcDeviceIdentity,oidcDeviceName,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?)')
        .run(id,session.actor.id,label,session.deviceIdentity,session.deviceName,now,expiresAt);
      const insert=this.db.prepare('INSERT INTO device_keys(hash,userId,deviceId,role) VALUES(?,?,?,?)');
      insert.run(tokenHash(agentToken),session.actor.id,id,'agent');insert.run(tokenHash(workerToken),session.actor.id,id,'worker');
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return {id,agentToken,workerToken,expiresAt};
  }
  token(token:string):Actor|undefined {
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return;
    const row=this.db.prepare(`SELECT k.userId,k.role,k.deviceId,p.name,d.lastSeen FROM device_keys k
      JOIN devices d ON d.id=k.deviceId JOIN people p ON p.id=k.userId
      WHERE k.hash=? AND d.revokedAt IS NULL AND d.expiresAt>?`).get(tokenHash(token),Date.now()) as any;
    if(!row)return;
    if(!row.lastSeen||Date.now()-row.lastSeen>60000)this.db.prepare('UPDATE devices SET lastSeen=? WHERE id=?').run(Date.now(),row.deviceId);
    return {id:row.userId,name:row.name,role:row.role,deviceId:row.deviceId};
  }
  devices(actor:Actor){
    if(actor.role!=='human')throw new AppError(403,'Browser login required');
    return this.db.prepare('SELECT id,label,oidcDeviceIdentity,oidcDeviceName,createdAt,lastSeen,expiresAt,revokedAt FROM devices WHERE userId=? ORDER BY createdAt DESC').all(actor.id);
  }
  revoke(actor:Actor,id:string){
    if(actor.role!=='human')throw new AppError(403,'Browser login required');
    const result=this.db.prepare('UPDATE devices SET revokedAt=? WHERE id=? AND userId=? AND revokedAt IS NULL').run(Date.now(),id,actor.id);
    if(!result.changes)throw new AppError(404,'Device not found');
  }
  private cleanup(){const now=Date.now();this.db.prepare('DELETE FROM browser_sessions WHERE expiresAt<=?').run(now);this.db.prepare('DELETE FROM oidc_flows WHERE expiresAt<=?').run(now);}
}
