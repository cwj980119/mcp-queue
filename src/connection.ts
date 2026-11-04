import { z } from 'zod';

export const connectionSchema = z.object({
  version: z.literal(1), serverUrl: z.string().url(), userId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: z.string().min(1).max(100),
  humanToken: z.string().regex(/^[A-Za-z0-9_-]{20,256}$/), agentToken: z.string().regex(/^[A-Za-z0-9_-]{20,256}$/), workerToken: z.string().regex(/^[A-Za-z0-9_-]{20,256}$/)
}).strict().superRefine((value,ctx)=>{
  const url=new URL(value.serverUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')
    ctx.addIssue({code:'custom',message:'서버 주소는 http(s)://호스트:포트 형식이어야 합니다.'});
});
export type Connection = z.infer<typeof connectionSchema>;
export function readConnection(text: string): Connection {
  if(text.length>12000)throw new Error('연결 파일이 너무 큽니다.');
  const value=text.trim();
  return connectionSchema.parse(JSON.parse(value.startsWith('mq1.')?Buffer.from(value.slice(4),'base64url').toString('utf8'):value));
}
