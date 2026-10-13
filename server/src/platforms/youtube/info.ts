// YouTube PlatformInfo (rendered generically by the UI) and destination option parsing.

import type { PlatformInfo } from '../../../../shared/types.js';
import { truncateTitle } from '../common/http.js';

export type Privacy = 'public' | 'unlisted' | 'private';
export type Latency = 'normal' | 'low' | 'ultraLow';

export interface YouTubeOptions {
  privacy: Privacy;
  latency: Latency;
  madeForKids: boolean;
  enableChat: boolean;
}

const PRIVACY: readonly Privacy[] = ['public', 'unlisted', 'private'];
const LATENCY: readonly Latency[] = ['normal', 'low', 'ultraLow'];

/** snippet.title limit (liveBroadcasts.insert/update). */
export const TITLE_MAX = 100;

export const YOUTUBE_INFO: PlatformInfo = {
  id: 'youtube',
  name: 'YouTube',
  feeds: ['landscape', 'vertical'],
  defaultFeed: 'landscape',
  connectMethod: 'device-code',
  accountFields: [],
  destinationFields: [
    {
      key: 'privacy',
      label: 'Privacy',
      type: 'select',
      target: 'option',
      default: 'public',
      options: [
        { value: 'public', label: 'Public' },
        { value: 'unlisted', label: 'Unlisted' },
        { value: 'private', label: 'Private' },
      ],
      help: 'Who can watch each broadcast. Use Private to test.',
    },
    {
      key: 'latency',
      label: 'Latency',
      type: 'select',
      target: 'option',
      default: 'low',
      options: [
        { value: 'normal', label: 'Normal (best quality)' },
        { value: 'low', label: 'Low' },
        { value: 'ultraLow', label: 'Ultra-low (max 1080p, no captions)' },
      ],
    },
    {
      key: 'madeForKids',
      label: 'Made for kids',
      type: 'boolean',
      target: 'option',
      default: false,
      help: 'Required by YouTube. Broadcasts made for kids have live chat turned off.',
    },
    {
      key: 'enableChat',
      label: 'Show chat',
      type: 'boolean',
      target: 'option',
      default: true,
      help: "Read this broadcast's chat into the chat panel and overlay. Turn off to save API quota.",
    },
  ],
  developerApp: {
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: '1234567890-abc.apps.googleusercontent.com' },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
    ],
    instructions: [
      '1. Open the Google Cloud console (console.cloud.google.com) and create a project (or pick one).',
      '2. APIs & Services → Library → search "YouTube Data API v3" → Enable.',
      '3. Google Auth Platform (OAuth consent screen) → Get started: app name, your e-mail, Audience "External", contact e-mail → Create.',
      '4. Audience → Test users → add the Google account that owns your YouTube channel.',
      '5. Audience → Publish app, so the status is "In production". Otherwise Google expires the sign-in after 7 days. Verification is not needed for your own use.',
      '6. Clients (Credentials) → Create client → Application type "TVs and Limited Input devices" → Create.',
      '7. Copy the Client ID and Client secret here, then connect your channel in Accounts.',
    ].join('\n'),
  },
  titleSupport: 'api',
  chatSupport: 'api',
  keyPerSession: false,
  experimental: false,
  notes:
    'Live streaming must be enabled on the channel (youtube.com/features); the first time can take up to 24 hours. ' +
    'Each destination gets its own broadcast per stream: add one destination per feed (vertical lives can show in the Shorts feed). ' +
    'The YouTube API has a daily quota (10,000 units by default) shared by every YouTube account using your developer app; ' +
    'reading chat uses most of it, so turn chat off on destinations where you do not need it.',
};

/** Read destination options defensively (the UI normalizes them, old rows may not be). */
export function readOptions(options: Record<string, unknown>): YouTubeOptions {
  const privacy = PRIVACY.find((p) => p === options.privacy) ?? 'public';
  const latency = LATENCY.find((l) => l === options.latency) ?? 'low';
  return {
    privacy,
    latency,
    madeForKids: options.madeForKids === true,
    enableChat: options.enableChat !== false,
  };
}

/**
 * Title for snippet.title: single line, no angle brackets (YouTube rejects `<` and `>` in titles),
 * at most 100 characters. Falls back when the result is empty (the title is required).
 */
export function youtubeTitle(title: string, fallback: string): string {
  const clean = (s: string) =>
    truncateTitle(s.replace(/[\r\n\t]+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/ {2,}/g, ' '), TITLE_MAX).trim();
  return clean(title) || clean(fallback) || 'Live stream';
}
