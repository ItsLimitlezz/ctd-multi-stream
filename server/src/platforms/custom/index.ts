// Custom RTMP: push one feed to any RTMP(S) server (Trovo, Owncast, PeerTube, another restreamer...).
// No account, no title, no chat: the URL (+ optional key) is all there is.

import type { Destination, PlatformInfo } from '../../../../shared/types.js';
import { DriverError, type DriverContext, type PlatformDriver, type PreparedLive } from '../types.js';
import { joinIngestUrl, rtmpUrlProblem, safeHost, streamKeyProblem } from './url.js';

const info: PlatformInfo = {
  id: 'custom',
  name: 'Custom RTMP',
  feeds: ['landscape', 'vertical'],
  defaultFeed: 'landscape',
  connectMethod: 'none',
  accountFields: [],
  destinationFields: [
    {
      key: 'ingestUrl',
      label: 'Server URL',
      type: 'url',
      target: 'ingestUrl',
      required: true,
      placeholder: 'rtmp://live.example.com/app',
      help: 'rtmp:// or rtmps:// server URL',
    },
    {
      key: 'streamKey',
      label: 'Stream key',
      type: 'secret',
      target: 'streamKey',
      required: false,
      help: 'Appended to the URL; leave empty if the key is already in the URL',
    },
  ],
  developerApp: null,
  titleSupport: 'none',
  chatSupport: 'none',
  keyPerSession: false,
  experimental: false,
  notes:
    'For any service that is not built in (Trovo, Owncast, PeerTube, a second restreamer, your own server...). ' +
    'Video is passed through unchanged; the title and chat are not managed for custom destinations.',
};

async function readKey(ctx: DriverContext): Promise<string> {
  return ((await ctx.destinationSecrets?.get('streamKey')) ?? '').trim();
}

async function problems(dest: Destination, ctx: DriverContext): Promise<string[]> {
  const out: string[] = [];
  const urlProblem = rtmpUrlProblem(dest.ingestUrl);
  if (urlProblem) out.push(urlProblem);
  const keyProblem = streamKeyProblem(await readKey(ctx));
  if (keyProblem) out.push(keyProblem);
  return out;
}

export const customDriver: PlatformDriver = {
  info,

  async validateDestination(dest, _account, ctx) {
    return problems(dest, ctx);
  },

  async prepare(dest, _account, _title, ctx): Promise<PreparedLive> {
    const found = await problems(dest, ctx);
    if (found.length > 0) throw new DriverError(`${found.join('; ')}. Edit the destination.`, 'misconfigured');
    const url = joinIngestUrl(dest.ingestUrl!, await readKey(ctx));
    ctx.log.info({ server: safeHost(url), feed: dest.feed }, 'custom RTMP destination ready');
    return { push: { url, mode: 'copy', feeds: [dest.feed] } };
  },
};
