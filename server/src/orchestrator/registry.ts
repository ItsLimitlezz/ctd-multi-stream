// One go-live engine (SessionOrchestrator) per profile. Profiles run independently and at the same
// time: each orchestrator only reacts to its own profile's OBS feeds and destinations, so OBS
// starting on the "DPRTMNT" profile never starts "Miami or Bust" (and vice versa).
//
// Orchestrators are created for every profile on init(), when a profile is added, and on demand
// (get/summaries) for a profile that exists in the repo but was not added yet. A removed profile
// is never re-created, even while its row is still being deleted.

import type { Logger } from 'pino';
import { DEFAULT_PROFILE_ID, type Profile, type ProfileSummary } from '../../../shared/types.js';
import type { AppServices, Orchestrator, OrchestratorRegistry } from '../services.js';
import { errorMessage } from './async-utils.js';
import { createOrchestrator, type OrchestratorOptions, type SessionOrchestrator } from './orchestrator.js';

/** Longest `?profile=` value accepted (profile ids are UUIDs or 'default'). */
const MAX_PROFILE_PARAM = 100;

/** Error for an unknown profile: HTTP 404, code 'unknown_profile' (mapped by the app error handler). */
export function unknownProfileError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('Unknown profile'), { statusCode: 404, code: 'unknown_profile' });
}

/** True for the error thrown by OrchestratorRegistry.get() for an unknown profile. */
export function isUnknownProfileError(err: unknown): boolean {
  const e = err as { statusCode?: unknown; code?: unknown } | null;
  return !!e && e.statusCode === 404 && e.code === 'unknown_profile';
}

/**
 * The profile id a request asks for with `?profile=<id>`: the default profile when omitted or
 * empty, null when malformed (repeated parameter, not a string, too long). Whether the profile
 * exists is up to OrchestratorRegistry.get().
 */
export function profileParam(query: unknown): string | null {
  const raw = query && typeof query === 'object' ? (query as Record<string, unknown>).profile : undefined;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PROFILE_ID;
  if (typeof raw !== 'string' || raw.length > MAX_PROFILE_PARAM) return null;
  return raw;
}

export function createOrchestratorRegistry(services: AppServices, opts: Omit<OrchestratorOptions, 'profileId'> = {}): OrchestratorRegistry {
  return new ProfileOrchestrators(services, opts);
}

class ProfileOrchestrators implements OrchestratorRegistry {
  private readonly byId = new Map<string, SessionOrchestrator>();
  /** Profiles removed while running: never re-created (their row may still exist for a moment). */
  private readonly removed = new Set<string>();
  private readonly log: Logger;
  private initialized = false;
  private closed = false;

  constructor(
    private readonly services: AppServices,
    private readonly opts: Omit<OrchestratorOptions, 'profileId'>,
  ) {
    this.log = services.log.child({ mod: 'orchestrators' });
  }

  get(profileId: string): Orchestrator {
    const orch = this.ensure(profileId);
    if (!orch) throw unknownProfileError();
    return orch;
  }

  all(): Orchestrator[] {
    return [...this.byId.values()];
  }

  async add(profile: Profile): Promise<void> {
    if (this.closed) return;
    this.removed.delete(profile.id);
    const orch = this.byId.get(profile.id) ?? this.create(profile.id);
    if (this.initialized) await this.initOne(orch);
  }

  async remove(profileId: string): Promise<void> {
    if (profileId === DEFAULT_PROFILE_ID) {
      throw Object.assign(new Error('The default profile cannot be removed'), { statusCode: 400, code: 'default_profile' });
    }
    this.removed.add(profileId);
    const orch = this.byId.get(profileId);
    if (!orch) return;
    this.byId.delete(profileId);
    this.log.info({ profileId }, 'removing profile orchestrator');
    try {
      await orch.stop('profile-deleted');
    } finally {
      await orch.shutdown();
    }
  }

  summaries(): ProfileSummary[] {
    const out: ProfileSummary[] = [];
    for (const profile of this.profiles()) {
      const orch = this.ensure(profile.id);
      if (orch) out.push(orch.summary(profile));
    }
    return out;
  }

  async init(): Promise<void> {
    if (this.closed || this.initialized) return;
    this.initialized = true;
    for (const profile of this.profiles()) this.ensure(profile.id);
    // The default profile always runs, even if its row can't be read (it is never deleted).
    this.ensure(DEFAULT_PROFILE_ID);
    await Promise.all([...this.byId.values()].map((orch) => this.initOne(orch)));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const all = [...this.byId.values()];
    // In parallel: every profile's lives end within the same shutdown budget.
    await Promise.all(
      all.map((orch) =>
        orch.shutdown().catch((err: unknown) =>
          this.log.error({ profileId: orch.profileId, error: errorMessage(err) }, 'stopping profile orchestrator failed'),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------

  /** The profile's orchestrator, created when the profile exists; null for an unknown/removed one. */
  private ensure(profileId: string): SessionOrchestrator | null {
    const existing = this.byId.get(profileId);
    if (existing) return existing;
    if (this.closed || this.removed.has(profileId) || !this.exists(profileId)) return null;
    const orch = this.create(profileId);
    // Created after startup (a profile that was never add()ed): start listening right away.
    if (this.initialized) void this.initOne(orch);
    return orch;
  }

  private create(profileId: string): SessionOrchestrator {
    const orch = createOrchestrator(this.services, { ...this.opts, profileId });
    this.byId.set(profileId, orch);
    return orch;
  }

  private async initOne(orch: SessionOrchestrator): Promise<void> {
    try {
      await orch.init();
    } catch (err) {
      this.log.error({ profileId: orch.profileId, error: errorMessage(err) }, 'starting profile orchestrator failed');
    }
  }

  private exists(profileId: string): boolean {
    if (profileId === DEFAULT_PROFILE_ID) return true;
    try {
      return this.services.repos.profiles.get(profileId) !== null;
    } catch (err) {
      this.log.warn({ profileId, error: errorMessage(err) }, 'reading profile failed');
      return false;
    }
  }

  /** Every profile (oldest first) minus removed ones. */
  private profiles(): Profile[] {
    try {
      return this.services.repos.profiles.list().filter((p) => !this.removed.has(p.id));
    } catch (err) {
      this.log.error({ error: errorMessage(err) }, 'listing profiles failed');
      return [];
    }
  }
}
