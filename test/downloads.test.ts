import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { registerDownloads, defaultWindowsDownload } from '../src/downloads.js';

test('installer download is accessible before login and supports a company HTTPS mirror',async()=>{
  for(const configured of ['', 'https://downloads.corp.test/MCP-Queue-Setup.exe']){
    const app=express();registerDownloads(app,{CLIENT_WINDOWS_DOWNLOAD_URL:configured});
    const server=createServer(app);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    try{
      const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/download/windows`,{redirect:'manual'});
      assert.equal(response.status,302);assert.equal(response.headers.get('location'),configured||defaultWindowsDownload);
      assert.equal(response.headers.get('set-cookie'),null);
    }finally{await new Promise<void>(done=>{server.close(()=>done());server.closeIdleConnections();});}
  }
  for(const value of ['javascript:alert(1)','http://downloads.corp.test/setup.exe','https://user:secret@downloads.corp.test/setup.exe'])
    assert.throws(()=>registerDownloads(express(),{CLIENT_WINDOWS_DOWNLOAD_URL:value}),/HTTPS/);
});
