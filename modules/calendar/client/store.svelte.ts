// Client state of the detail view: calendars, the loaded range of occurrences, and the writes.
import { DashError, type ModuleApi } from '@dash/contract';
import type { OccurrenceDto } from '../server/dto.js';
import type { EventInput } from '../server/ical.js';
import type { CalendarDto } from '../server/index.js';

export type { CalendarDto, OccurrenceDto, EventInput };
export type Scope = 'all' | 'this' | 'future';

/** The current event the server sent with a 409, or null when the error is not a conflict. */
export function conflictOf(err: unknown): { etag: string; event: unknown } | null {
  if (!(err instanceof DashError) || err.code !== 'conflict') return null;
  const d = err.details as { etag?: unknown; event?: unknown } | undefined;
  return typeof d?.etag === 'string' ? { etag: d.etag, event: d.event ?? null } : null;
}

export class CalendarStore {
  calendars = $state.raw<CalendarDto[]>([]);
  events = $state.raw<OccurrenceDto[]>([]);
  loaded = $state(false);
  failed = $state(false);
  #seq = 0;
  #range: { from: string; to: string } | null = null;
  readonly #api: ModuleApi;

  constructor(api: ModuleApi) {
    this.#api = api;
  }

  async loadCalendars(): Promise<void> {
    try {
      const res = await this.#api.get<{ calendars: CalendarDto[] }>('/calendars');
      this.calendars = res.calendars;
    } catch {
      this.failed = true;
    }
  }

  /** Loads the occurrences of `[from, to)`; an answer to an older request than the latest is dropped. */
  async load(from: string, to: string): Promise<void> {
    this.#range = { from, to };
    const seq = ++this.#seq;
    try {
      const res = await this.#api.get<{ events: OccurrenceDto[] }>('/events', { from, to });
      if (seq !== this.#seq) return;
      this.events = res.events;
      this.loaded = true;
      this.failed = false;
    } catch {
      if (seq === this.#seq) this.failed = true;
    }
  }

  reload(): Promise<void> {
    return this.#range ? this.load(this.#range.from, this.#range.to) : Promise.resolve();
  }

  async create(body: EventInput & { calendarId: string }): Promise<void> {
    await this.#api.post('/events', body);
    await this.reload();
  }

  async update(
    o: Pick<OccurrenceDto, 'uid' | 'calendarId' | 'etag' | 'recurrenceId'>,
    input: EventInput,
    scope: Scope,
    etag: string = o.etag,
  ): Promise<void> {
    await this.#api.put(`/events/${encodeURIComponent(o.uid)}`, {
      ...input,
      calendarId: o.calendarId,
      etag,
      scope,
      ...(scope !== 'all' && o.recurrenceId ? { occurrenceStart: o.recurrenceId } : {}),
    });
    await this.reload();
  }

  async remove(o: Pick<OccurrenceDto, 'uid' | 'calendarId' | 'etag' | 'recurrenceId'>, scope: Scope, etag: string = o.etag): Promise<void> {
    await this.#api.post(`/events/${encodeURIComponent(o.uid)}/delete`, {
      calendarId: o.calendarId,
      etag,
      scope,
      ...(scope !== 'all' && o.recurrenceId ? { occurrenceStart: o.recurrenceId } : {}),
    });
    await this.reload();
  }
}

/** The editable input of an occurrence (series fields for the whole series). */
export function inputOf(o: OccurrenceDto): EventInput {
  return {
    title: o.title,
    description: o.description,
    location: o.location,
    start: o.start,
    end: o.end,
    allDay: o.allDay,
    timeZone: o.timeZone,
    rrule: o.rrule,
  };
}

/**
 * The input for a whole-series write made from one instance: the instance's changes of start and end are applied to
 * the series' first instance (so moving Tuesday's stand-up by an hour moves the series, not its first date).
 */
export function seriesInput(o: OccurrenceDto, input: EventInput, shift: (wall: string, minutes: number) => string, diff: (a: string, b: string) => number): EventInput {
  if (!o.recurrenceId || input.allDay !== o.allDay) return input;
  return {
    ...input,
    start: shift(o.seriesStart, diff(o.start, input.start)),
    end: shift(o.seriesEnd, diff(o.end, input.end)),
  };
}
