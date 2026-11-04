import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const {serverAddress}=await import(pathToFileURL(resolve('scripts/server-address.mjs')).href) as {
  serverAddress:(env:Record<string,string>)=>{url:string;mode:string}
};
test('local-only server uses the published port, not the container port',()=>{
  assert.equal(serverAddress({QUEUE_PUBLIC_PORT:'4510',QUEUE_BIND_ADDRESS:'127.0.0.1',QUEUE_HOST_ADDRESS:'192.0.2.15'}).url,'http://localhost:4510');
});
test('LAN server uses a host-side detected address and the published port',()=>{
  assert.equal(serverAddress({QUEUE_PUBLIC_PORT:'4510',QUEUE_BIND_ADDRESS:'0.0.0.0',QUEUE_HOST_ADDRESS:'192.0.2.15'}).url,'http://192.0.2.15:4510');
});
test('an explicitly bound interface takes precedence over automatic detection',()=>{
  assert.equal(serverAddress({QUEUE_PUBLIC_PORT:'4510',QUEUE_BIND_ADDRESS:'198.51.100.4',QUEUE_HOST_ADDRESS:'192.0.2.15'}).url,'http://198.51.100.4:4510');
});
test('configured HTTPS address is preserved behind a reverse proxy',()=>{
  assert.equal(serverAddress({QUEUE_SERVER_URL:'https://queue.example.test/',QUEUE_PUBLIC_PORT:'4510',QUEUE_BIND_ADDRESS:'127.0.0.1'}).url,'https://queue.example.test');
});
test('all-interface binding never exports a wildcard or an invented container address',()=>{
  assert.throws(()=>serverAddress({QUEUE_BIND_ADDRESS:'0.0.0.0'}),/inside Docker/);
  assert.throws(()=>serverAddress({QUEUE_BIND_ADDRESS:'0.0.0.0',QUEUE_HOST_ADDRESS:'0.0.0.0'}),/user-reachable/);
  assert.throws(()=>serverAddress({QUEUE_SERVER_URL:'http://0.0.0.0:3000'}));
  assert.throws(()=>serverAddress({QUEUE_SERVER_URL:'https://queue.example.test/mcp'}));
  assert.throws(()=>serverAddress({QUEUE_PUBLIC_PORT:'99999'}));
});
test('IPv6 server addresses are bracketed correctly',()=>{
  assert.equal(serverAddress({QUEUE_PUBLIC_PORT:'4510',QUEUE_BIND_ADDRESS:'::',QUEUE_HOST_ADDRESS:'2001:db8::4'}).url,'http://[2001:db8::4]:4510');
});
