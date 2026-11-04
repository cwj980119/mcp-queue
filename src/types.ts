import { z } from 'zod';

export const createSchema = z.object({
  recipient: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(16000),
  documentRef: z.string().trim().max(2000).default(''),
  documentVersion: z.string().trim().max(200).default(''),
  idempotencyKey: z.string().min(8).max(200)
}).strict();
export type NewRequest = z.infer<typeof createSchema>;
export type Role = 'human' | 'agent' | 'worker';
export type Actor = { id: string; name: string; role: Role; deviceId?:string };
export type State = 'pending' | 'approved' | 'running' | 'draft' | 'replied' | 'rejected' | 'failed' | 'cancelled';
export type Task = {
  id: string; sender: string; recipient: string; title: string; body: string;
  documentRef: string; documentVersion: string; state: State;
  draft: string; result: string; error: string; runId: string | null;
  sessionId: string | null; createdAt: string; updatedAt: string;
};
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
