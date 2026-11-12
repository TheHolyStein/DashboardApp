import { z } from 'zod';

// DTO schemas for core REST + SSE. Server validates with them, client parses with them.
export const UserDto = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  role: z.enum(['admin', 'member']),
});

export const MeDto = UserDto.extend({
  grants: z.record(z.string(), z.enum(['none', 'view', 'edit'])),
  csrf: z.string(),
  prefs: z.object({
    theme: z.string(),
    modePolicy: z.enum(['day', 'night', 'system', 'sun']),
    locale: z.string(),
    timeZone: z.string(),
  }),
});

export const LayoutDto = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
});

export const InstanceDto = z.object({
  id: z.string(),
  moduleId: z.string(),
  pageId: z.string(),
  settings: z.unknown(),
  layout: LayoutDto,
  mobileOrder: z.number().int(),
});

export const PageDto = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  order: z.number().int(),
  ownerId: z.string(),
  shared: z.boolean(),
  background: z.string().nullable(),
  instances: z.array(InstanceDto),
});

export const SnapshotDto = z.object({
  instanceId: z.string(),
  data: z.unknown(),
  updatedAt: z.string().nullable(),
  stale: z.boolean(),
});

export const NotificationDto = z.object({
  id: z.string(),
  moduleId: z.string(),
  level: z.enum(['info', 'warn', 'critical']),
  title: z.string(),
  body: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: SnapshotDto }),
  z.object({ type: z.literal('notification'), notification: NotificationDto }),
  z.object({ type: z.literal('layout'), pageId: z.string() }),
  z.object({ type: z.literal('revoked'), moduleId: z.string() }),
  z.object({ type: z.literal('ping'), at: z.string() }),
]);

export const ErrorDto = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
