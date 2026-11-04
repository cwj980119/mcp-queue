import { isIP } from 'node:net';

export function serverAddress(env=process.env) {
  const explicit=env.QUEUE_SERVER_URL?.trim();
  if(explicit){
    const url=new URL(explicit);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||['0.0.0.0','[::]'].includes(url.hostname))
      throw new Error('QUEUE_SERVER_URL must be the user-facing HTTP(S) base URL, not a listening address or /mcp path.');
    return {url:url.origin,mode:'configured'};
  }
  const port=Number(env.QUEUE_PUBLIC_PORT||env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid published server port.');
  const listen=env.QUEUE_BIND_ADDRESS||env.BIND_ADDRESS||env.QUEUE_LISTEN_ADDRESS||'127.0.0.1';
  if(['localhost','127.0.0.1','::1','[::1]'].includes(listen))return {url:`http://localhost:${port}`,mode:'local'};
  const host=!['0.0.0.0','::','[::]'].includes(listen)?listen:(env.QUEUE_HOST_ADDRESS||env.COMPUTERNAME||'').trim();
  if(!host)throw new Error('Cannot determine the host address from inside Docker. Use the server start file or set QUEUE_SERVER_URL.');
  if(!isIP(host)&&!/^\[?[A-Za-z0-9][A-Za-z0-9._:-]*\]?$/.test(host))throw new Error('Invalid server host address.');
  if(['0.0.0.0','::','[::]','::1','[::1]','localhost','127.0.0.1','host.docker.internal'].includes(host))throw new Error('A user-reachable server host address is required.');
  const authority=isIP(host)===6?`[${host}]`:host;
  const url=new URL(`http://${authority}:${port}`);
  if(url.username||url.password||url.port!==String(port)&&![80].includes(port))throw new Error('Invalid server address.');
  return {url:url.origin,mode:'host'};
}
