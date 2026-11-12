// Seams between server tracks. Created by the orchestrator; edited by no track.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type BetterSqlite3 from 'better-sqlite3';
import type { ModuleId, PermissionLevel, UserId } from '@dash/contract';

export interface AuthSeam {                                   // implemented by track B, consumed by A
  plugin: FastifyPluginAsync;                                 // decorates request.user (or null); handles /api/auth/*, /api/me, /api/admin/users, /api/admin/grants
  requireUser(req: FastifyRequest): SessionUser;              // throws DashError('unauthenticated')
  levelFor(userId: UserId, moduleId: ModuleId): PermissionLevel;
  verifyAppPassword(basicAuthHeader: string | undefined): SessionUser | null;
  onGrantsChanged(cb: (userId: UserId, moduleId: ModuleId, level: PermissionLevel) => void): void;
  listUsers(): Array<{ id: UserId; name: string; handle: string; role: 'admin'|'member' }>;
}
export interface SessionUser { id: UserId; name: string; handle: string; role: 'admin'|'member' }
export interface CoreSeam {                                   // implemented by track A, consumed by B
  db: BetterSqlite3.Database;                                 // core tables via Drizzle
  audit(entry: { userId: UserId | null; action: string; detail?: object; ip?: string }): void;
  config: AppConfig;
}
export interface AppConfig { dataDir: string; configDir: string; host: '127.0.0.1'; port: number; baseUrl: string; secretKeyFile: string; env: 'development'|'production'|'test' }
