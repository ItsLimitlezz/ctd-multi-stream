// Facebook driver. Two account modes (account option `mode`):
// - 'page'    (default): Facebook Page through the Graph API Live Video API — page-mode.ts
// - 'profile' (experimental): persistent stream key + Live Producer browser automation — profile-mode.ts
// A destination without an account streams to its persistent key only (no title / chat).

import type { Account } from '../../../../shared/types.js';
import { DriverError, type PlatformDriver } from '../types.js';
import { facebookInfo } from './info.js';
import { checkPageAccount, completePageConnect, preparePageLive, startPageConnect, type PageModeEnv } from './page-mode.js';
import {
  checkProfileAccount,
  completeProfileConnect,
  prepareProfileLive,
  profileDestinationProblems,
  startProfileConnect,
  type ProfileModeEnv,
} from './profile-mode.js';

export type FacebookMode = 'page' | 'profile';

export function accountMode(account: Account | null): FacebookMode {
  return account?.options.mode === 'profile' ? 'profile' : 'page';
}

export interface FacebookDriverOptions {
  page?: PageModeEnv;
  profile?: ProfileModeEnv;
}

/** Build the driver; options only exist so tests can point it at local stubs. */
export function createFacebookDriver(opts: FacebookDriverOptions = {}): PlatformDriver {
  const pageEnv = opts.page ?? {};
  const profileEnv = opts.profile ?? {};

  return {
    info: facebookInfo,

    async startConnect(account, ctx) {
      return accountMode(account) === 'profile' ? startProfileConnect() : startPageConnect(account, ctx);
    },

    async completeConnect(account, input, ctx) {
      return accountMode(account) === 'profile'
        ? completeProfileConnect(account, ctx, profileEnv)
        : completePageConnect(account, input, ctx, pageEnv);
    },

    async checkAccount(account, ctx) {
      return accountMode(account) === 'profile' ? checkProfileAccount(account, ctx) : checkPageAccount(account, ctx, pageEnv);
    },

    async validateDestination(dest, account, ctx) {
      if (!account) {
        const hasKey = Boolean((await ctx.destinationSecrets?.get('streamKey'))?.trim());
        return hasKey
          ? profileDestinationProblems(dest, ctx)
          : ['Choose a connected Facebook account for this destination (or paste a persistent stream key)'];
      }
      if (accountMode(account) === 'profile') return profileDestinationProblems(dest, ctx);
      return [];
    },

    async prepare(dest, account, title, ctx) {
      if (account && account.platform !== 'facebook') {
        throw new DriverError('The account linked to this destination is not a Facebook account', 'misconfigured');
      }
      if (!account || accountMode(account) === 'profile') return prepareProfileLive(dest, account, title, ctx, profileEnv);
      return preparePageLive(dest, account, title, ctx, pageEnv);
    },
  };
}

export const facebookDriver: PlatformDriver = createFacebookDriver();
