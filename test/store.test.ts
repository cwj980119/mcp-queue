import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { createSchema, type Actor } from '../src/types.js';

const alice: Actor = {id:'alice',name:'A',role:'human'};
const bob: Actor = {id:'bob',name:'B',role:'human'};
const worker: Actor = {...bob,role:'worker'};
const outsider: Actor = {id:'charlie',name:'C',role:'human'};
const input = () => createSchema.parse({ recipient:'bob',title:'question',body:'read document',idempotencyKey:randomUUID() });
test('atomic claims across connections, run fencing, restart persistence, explicit recovery', () => {
  const dir = mkdtempSync(join(tmpdir(),'queue-store-')); const path=join(dir,'queue.sqlite');
  const users=[{id:'alice',name:'A'},{id:'bob',name:'B'},{id:'charlie',name:'C'}];
  const one=new Store(path,users),two=new Store(path,users);
  try {
    const first=one.create(alice,input()),second=one.create(alice,input());
    one.act(bob,first.id,'approve'); one.act(bob,second.id,'approve');
    const run=one.claim(worker)!; assert(run.runId); assert.equal(two.claim(worker),null);
    assert.throws(()=>one.get(outsider,first.id),/not found/);
    assert.throws(()=>one.complete({...worker,id:'alice'},run.id,run.runId!,'draft','bad'),/not found/);
    assert.throws(()=>one.complete(worker,run.id,randomUUID(),'draft','bad'),/no longer active/);
    assert.equal(two.get(bob,run.id).state,'running'); // Another connection/restart never auto-replays.
    one.act(bob,run.id,'interrupt');
    assert.throws(()=>two.complete(worker,run.id,run.runId!,'draft','late answer'),/no longer active/);
    assert.equal(two.get(bob,run.id).state,'failed');
    const next=two.claim(worker)!; assert.equal(next.id,second.id);
    two.complete(worker,next.id,next.runId!,'draft','private answer');
    assert.equal(one.get(alice,next.id).draft,'');
    one.act(bob,next.id,'publish','human-reviewed answer'); assert.equal(two.get(alice,next.id).result,'human-reviewed answer');
  } finally {one.close();two.close();rmSync(dir,{recursive:true,force:true});}
});
test('idempotency conflicts, role separation and state transitions', () => {
  const store=new Store(':memory:',[{id:'alice',name:'A'},{id:'bob',name:'B'}]);
  try {
    const data=input(),task=store.create(alice,data); assert.equal(store.create(alice,data).id,task.id);
    assert.throws(()=>store.create(alice,{...data,body:'changed'}),/different content/);
    assert.throws(()=>store.create(worker,input()),/cannot create/);
    assert.throws(()=>store.act({...bob,role:'agent'},task.id,'approve'),/Human/);
    assert.throws(()=>store.act(bob,task.id,'publish','premature'),/not allowed/);
    store.act(alice,task.id,'cancel'); assert.throws(()=>store.act(bob,task.id,'approve'),/not allowed/);
    assert.equal(store.claim(worker),null);
  } finally {store.close();}
});
