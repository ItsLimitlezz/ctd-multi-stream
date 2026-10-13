import type { PlatformId } from '../../../shared/types.js';
import type { PlatformRegistry } from '../services.js';
import { customDriver } from './custom/index.js';
import { facebookDriver } from './facebook/index.js';
import { instagramDriver } from './instagram/index.js';
import { kickDriver } from './kick/index.js';
import { tiktokDriver } from './tiktok/index.js';
import { twitchDriver } from './twitch/index.js';
import type { PlatformDriver } from './types.js';
import { xDriver } from './x/index.js';
import { youtubeDriver } from './youtube/index.js';

export function createPlatformRegistry(
  drivers: PlatformDriver[] = [
    twitchDriver,
    youtubeDriver,
    kickDriver,
    facebookDriver,
    xDriver,
    instagramDriver,
    tiktokDriver,
    customDriver,
  ],
): PlatformRegistry {
  const byId = new Map<PlatformId, PlatformDriver>(drivers.map((d) => [d.info.id, d]));
  return {
    get(id) {
      const d = byId.get(id);
      if (!d) throw Object.assign(new Error(`Unknown platform: ${id}`), { statusCode: 400, code: 'unknown_platform' });
      return d;
    },
    all: () => [...byId.values()],
  };
}
