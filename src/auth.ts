import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from './types.js';

export const authSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().min(1),
  role: z.enum(['human', 'agent', 'worker']), tokenHash: z.string().regex(/^[0-9a-f]{64}$/)
}));
export type AuthEntry = z.infer<typeof authSchema>[number];
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function authenticate(entries: AuthEntry[], token: string): Actor | undefined {
  const digest = Buffer.from(tokenHash(token), 'hex');
  const match = entries.find(e => timingSafeEqual(Buffer.from(e.tokenHash, 'hex'), digest));
  return match && { id: match.id, name: match.name, role: match.role };
}
