import { DashError, MeDto } from '@dash/contract';
import type { z } from 'zod';
import { api, configureApi } from './api.js';
import { stream } from './stream.svelte.js';

type Me = z.infer<typeof MeDto>;

class Session {
  me = $state<Me | null>(null);
  status = $state<'loading' | 'signedOut' | 'signedIn'>('loading');

  private setMe(me: Me | null): void {
    this.me = me;
    this.status = me ? 'signedIn' : 'signedOut';
    if (me) stream.connect();
    else stream.disconnect();
  }

  async refresh(): Promise<void> {
    try {
      this.setMe(await api.get('/me', MeDto));
    } catch (e) {
      if (e instanceof DashError && e.code === 'unauthenticated') this.setMe(null);
      else throw e;
    }
  }

  async login(name: string, password: string, totp?: string): Promise<void> {
    this.setMe(await api.post('/auth/login', { name, password, ...(totp ? { totp } : {}) }, MeDto));
  }

  async logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } finally {
      this.setMe(null);
    }
  }

  /** Drop the session locally without a request (also used by the api layer on 401, and by tests). */
  clear(): void {
    this.setMe(null);
  }
}

export const session = new Session();

configureApi({ getCsrf: () => session.me?.csrf, onUnauthenticated: () => session.clear() });
