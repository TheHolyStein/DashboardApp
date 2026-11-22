import { DashError } from '@dash/contract';
import { z } from 'zod';

// Shapes of the admin and account routes (the server answers with these; the contract package has no DTO for them).
export const AdminUser = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  role: z.enum(['admin', 'member']),
  disabled: z.boolean(),
  totpEnabled: z.boolean(),
  createdAt: z.string(),
});
export type AdminUserT = z.infer<typeof AdminUser>;

export const AdminModule = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  failed: z.boolean(),
  levels: z.array(z.enum(['view', 'edit'])),
  hasConfig: z.boolean(),
});
export type AdminModuleT = z.infer<typeof AdminModule>;

export const GrantRow = z.object({ userId: z.string(), moduleId: z.string(), level: z.enum(['none', 'view', 'edit']) });
export type GrantLevel = z.infer<typeof GrantRow>['level'];

export const AppPassword = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export const CreatedAppPassword = z.object({ id: z.string(), label: z.string(), password: z.string() });
export const TotpSetup = z.object({ otpauthUrl: z.string(), secret: z.string() });
export const Health = z.object({ ok: z.boolean(), version: z.string(), contract: z.union([z.string(), z.number()]) });

export const isCode = (e: unknown, code: string): boolean => e instanceof DashError && e.code === code;
/** An admin route answered 403: the user is not an administrator (any more). */
export const isForbidden = (e: unknown): boolean => isCode(e, 'forbidden');
export const isWrongPassword = (e: unknown): boolean =>
  e instanceof DashError && e.code === 'forbidden' && (e.details as { reason?: unknown } | undefined)?.reason === 'wrong_password';
