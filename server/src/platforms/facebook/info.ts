import type { PlatformInfo } from '../../../../shared/types.js';
import { PAGE_SCOPES } from './page-mode.js';
import { DEFAULT_INGEST_URL } from './profile-mode.js';

export const facebookInfo: PlatformInfo = {
  id: 'facebook',
  name: 'Facebook',
  feeds: ['landscape', 'vertical'],
  defaultFeed: 'landscape',
  connectMethod: 'oauth-paste',
  accountFields: [
    {
      key: 'mode',
      label: 'Account type',
      type: 'select',
      required: true,
      default: 'page',
      options: [
        { value: 'page', label: 'Facebook Page (Graph API)' },
        { value: 'profile', label: 'Personal profile (browser, experimental)' },
      ],
      help: 'Page: official API, needs your own Meta developer app. Profile: log in through the built-in browser and use a persistent stream key.',
    },
    {
      key: 'pageId',
      label: 'Page ID',
      type: 'text',
      placeholder: 'e.g. 104123456789012',
      help: 'Page mode only. Leave empty to use your first Page (it is filled in after connecting).',
    },
  ],
  destinationFields: [
    {
      key: 'privacy',
      label: 'Audience (Page mode)',
      type: 'select',
      target: 'option',
      default: 'public',
      options: [
        { value: 'public', label: 'Public' },
        { value: 'self', label: 'Only me (test)' },
      ],
      help: 'Page mode: who can see the live video. "Only me" is for test streams.',
    },
    {
      key: 'ingestUrl',
      label: 'Server URL (profile mode)',
      type: 'url',
      target: 'ingestUrl',
      default: DEFAULT_INGEST_URL,
      help: 'Profile mode: use a persistent stream key from facebook.com/live/producer. Page mode ignores this (a new stream URL is created for every live).',
    },
    {
      key: 'streamKey',
      label: 'Persistent stream key (profile mode)',
      type: 'secret',
      target: 'streamKey',
      help: 'Profile mode: use a persistent stream key from facebook.com/live/producer (Streaming software → Advanced settings → Persistent stream key). Not needed for Page mode.',
    },
  ],
  developerApp: {
    consoleUrl: 'https://developers.facebook.com/apps',
    fields: [
      { key: 'clientId', label: 'App ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'App secret', type: 'secret', required: true },
      {
        key: 'configId',
        label: 'Login configuration ID (optional)',
        type: 'text',
        help: 'Only if your app uses Facebook Login for Business configurations; leave empty otherwise.',
      },
    ],
    instructions: [
      '1. Only needed for Facebook Page accounts (profile mode needs no developer app).',
      '2. Open developers.facebook.com/apps, click "Create app", enter a name and your email.',
      '3. Choose the use case "Manage everything on your Page" (connecting a business portfolio is optional).',
      `4. In the dashboard, customize that use case and add the permissions ${PAGE_SCOPES.join(', ')}.`,
      '5. Open Facebook Login for Business (or Facebook Login) → Settings and add the redirect URL shown on this page to "Valid OAuth Redirect URIs", then save.',
      '6. Keep the app in Development mode: you are its admin, so no App Review is needed (only accounts with a role on the app can connect).',
      '7. Copy the App ID and App secret from App settings → Basic into the fields below.',
      '8. Optional: if the login dialog insists on a configuration, create one under Facebook Login for Business → Configurations (token type "User access token", the permissions above) and paste its ID below.',
    ].join('\n'),
  },
  titleSupport: 'api',
  chatSupport: 'api',
  keyPerSession: false,
  experimental: false,
  notes:
    'Page mode creates a new live video through the Graph API for every stream (title + chat via API). Profile mode is experimental: video goes to your persistent stream key and the title, the "Go live" click and chat are automated in Facebook Live Producer (English UI) on a best-effort basis. Facebook requires accounts to be at least 60 days old and Pages/professional profiles to have at least 100 followers to go live.',
};
