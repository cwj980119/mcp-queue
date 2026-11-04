import type { Express } from 'express';
export const defaultWindowsDownload='https://github.com/cwj980119/mcp-queue/releases/latest/download/MCP-Queue-Setup.exe';
export function registerDownloads(app:Express,env:NodeJS.ProcessEnv=process.env){
  const windows=env.CLIENT_WINDOWS_DOWNLOAD_URL||defaultWindowsDownload;
  const url=new URL(windows);
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('CLIENT_WINDOWS_DOWNLOAD_URL must be an HTTPS installer URL.');
  app.get('/download/windows',(_req,res)=>res.redirect(302,url.href));
}
