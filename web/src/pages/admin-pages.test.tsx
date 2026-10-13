import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectStart, SettingsResponse } from '@shared/api';
import type { Account, Destination, PlatformInfo, TlsStatus } from '@shared/types';
import { AuthProvider } from '../state/auth';
import { LiveProvider } from '../state/live';
import { AccountForm } from './accounts/AddAccountModal';
import { ConnectModal, Instructions, type ConnectState } from './accounts/ConnectModal';
import { DestinationForm } from './destinations/DestinationForm';
import { PlatformPicker } from './destinations/PlatformPicker';
import { AboutTab } from './settings/AboutTab';
import { GeneralTab } from './settings/GeneralTab';
import { HttpsTab } from './settings/HttpsTab';

const html = (el: ReactElement) => renderToStaticMarkup(el);
const withProviders = (el: ReactElement) =>
  html(
    <AuthProvider>
      <LiveProvider>{el}</LiveProvider>
    </AuthProvider>,
  );
const noop = () => undefined;

const kick: PlatformInfo = {
  id: 'kick',
  name: 'Kick',
  feeds: ['landscape'],
  defaultFeed: 'landscape',
  connectMethod: 'oauth-paste',
  accountFields: [],
  destinationFields: [
    { key: 'server', label: 'Server URL', type: 'url', target: 'ingestUrl', required: true },
    { key: 'key', label: 'Stream key', type: 'secret', target: 'streamKey' },
  ],
  developerApp: { consoleUrl: 'https://kick.com/settings/developer', fields: [], instructions: '' },
  titleSupport: 'api',
  chatSupport: 'api',
  keyPerSession: false,
  experimental: false,
  notes: 'Paste the stream key from your Kick dashboard.',
};

const instagram: PlatformInfo = {
  ...kick,
  id: 'instagram',
  name: 'Instagram',
  feeds: ['vertical'],
  defaultFeed: 'vertical',
  connectMethod: 'browser',
  destinationFields: [],
  developerApp: null,
  keyPerSession: true,
  experimental: true,
  notes: undefined,
};

const account: Account = {
  id: 'acc1',
  platform: 'kick',
  label: 'my_channel',
  status: 'pending',
  statusMessage: null,
  options: {},
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const dest: Destination = {
  id: 'd1',
  platform: 'kick',
  accountId: null,
  name: 'Kick main',
  feed: 'landscape',
  enabled: true,
  options: {},
  ingestUrl: 'rtmps://ingest.example/app',
  hasStreamKey: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const connect = (start: ConnectStart | null, state?: ConnectState) =>
  withProviders(
    <ConnectModal
      account={account}
      info={kick}
      state={state ?? (start ? { phase: 'ready', start } : { phase: 'starting' })}
      onRestart={noop}
      onConnected={noop}
      onClose={noop}
    />,
  );

describe('destinations UI (static render)', () => {
  it('PlatformPicker shows feeds, experimental flag and notes', () => {
    const out = html(<PlatformPicker platforms={[instagram, kick]} onPick={noop} />);
    expect(out.indexOf('Kick')).toBeLessThan(out.indexOf('Instagram'));
    expect(out).toContain('Vertical only');
    expect(out).toContain('Landscape only');
    expect(out).toContain('Experimental');
    expect(out).toContain('Paste the stream key from your Kick dashboard.');
  });

  it('DestinationForm (new) links to the accounts page when no account exists', () => {
    const out = html(<DestinationForm info={kick} accounts={[]} existing={null} onSaved={noop} onCancel={noop} onBack={noop} />);
    expect(out).toContain('href="/accounts?add=kick"');
    expect(out).toContain('value="Kick"');
    expect(out).toContain('Change platform');
    expect(out).toContain('Add destination');
    expect(out).toContain('type="password"');
  });

  it('DestinationForm (edit) shows the stored key as set and offers to remove it', () => {
    const out = html(<DestinationForm info={kick} accounts={[account]} existing={dest} onSaved={noop} onCancel={noop} />);
    expect(out).toContain('•••• set');
    expect(out).toContain('Remove the saved stream key');
    expect(out).toContain('value="rtmps://ingest.example/app"');
    expect(out).toContain('my_channel (not connected)');
    expect(out).toContain('Save changes');
    expect(out).not.toContain('Change platform');
  });

  it('DestinationForm explains vertical-only and per-stream keys', () => {
    const out = html(<DestinationForm info={instagram} accounts={undefined} existing={null} onSaved={noop} onCancel={noop} />);
    expect(out).toContain('Instagram only accepts the vertical feed.');
    expect(out).toContain('new stream key for every stream');
    expect(out).toContain('Loading accounts');
    expect(out).toMatch(/<select[^>]*disabled/);
  });
});

describe('connect flow (static render)', () => {
  it('device code: big code, open + copy buttons, countdown', () => {
    const out = connect({
      method: 'device-code',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://www.twitch.tv/activate',
      verificationUriComplete: 'https://www.twitch.tv/activate?device-code=WDJB-MJHT',
      expiresIn: 1800,
      interval: 5,
    });
    expect(out).toContain('WDJB-MJHT');
    expect(out).toContain('href="https://www.twitch.tv/activate?device-code=WDJB-MJHT"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('Copy code');
    expect(out).toContain('30:00');
  });

  it('oauth paste: login link, redirect URI and paste field', () => {
    const out = connect({
      method: 'oauth-paste',
      authorizeUrl: 'https://id.kick.com/oauth/authorize?client_id=x&state=acc1.r',
      redirectUri: 'https://203.0.113.7/oauth/callback/kick',
      instructions: 'Log in with the account you stream from.',
    });
    expect(out).toContain('href="https://id.kick.com/oauth/authorize?client_id=x&amp;state=acc1.r"');
    expect(out).toContain('https://203.0.113.7/oauth/callback/kick');
    expect(out).toContain('Address you landed on');
    expect(out).toContain('Log in with the account you stream from.');
  });

  it('oauth paste: an unsafe authorize URL is not rendered as a link', () => {
    const out = connect({ method: 'oauth-paste', authorizeUrl: 'javascript:alert(1)', redirectUri: 'https://h/cb', instructions: '' });
    expect(out).not.toContain('javascript:');
    expect(out).toContain('invalid link');
  });

  it('token paste renders the driver fields', () => {
    const out = connect({
      method: 'token-paste',
      fields: [{ key: 'token', label: 'Page access token', type: 'secret', required: true }],
      instructions: '1. Open Graph API Explorer\n2. Copy the token',
    });
    expect(out).toContain('Page access token');
    expect(out).toContain('<ol class="steps">');
    expect(out).toContain('Open Graph API Explorer');
  });

  it('browser login shows the live viewer and the confirm buttons', () => {
    const out = connect({ method: 'browser', startUrl: 'https://kick.com/login', instructions: 'Log in to Kick.' });
    expect(out).toContain('role="application"');
    expect(out).toContain('I&#x27;m logged in');
    expect(out).toContain('Cancel');
  });

  it('starting and failed (missing developer app) states', () => {
    expect(connect(null)).toContain('Contacting Kick');
    const failed = connect(null, { phase: 'failed', message: 'Set up the Kick developer app first.', misconfigured: true });
    expect(failed).toContain('Set up the Kick developer app first.');
    expect(failed).toContain('href="/settings?tab=apps"');
    expect(failed).toContain('Try again');
  });

  it('add account: Facebook Page mode asks for the Meta app, profile mode can continue without it', () => {
    const facebook: PlatformInfo = {
      ...kick,
      id: 'facebook',
      name: 'Facebook',
      accountFields: [
        {
          key: 'mode',
          label: 'Account type',
          type: 'select',
          required: true,
          default: 'page',
          options: [
            { value: 'page', label: 'Page' },
            { value: 'profile', label: 'Profile' },
          ],
        },
      ],
    };
    const apps = [{ platform: 'facebook' as const, configured: false, values: {}, secretsSet: {}, redirectUri: null }];
    const form = (info: PlatformInfo) =>
      html(<AccountForm info={info} apps={apps} onBack={noop} onCancel={noop} onCreated={noop} />);

    const page = form(facebook);
    expect(page).toContain('needs a free developer app');
    expect(page).toContain('href="/settings?tab=apps"');
    expect(page).not.toContain('Continue');

    const profileField = { ...facebook.accountFields[0]!, default: 'profile' };
    const profile = form({ ...facebook, accountFields: [profileField] });
    expect(profile).not.toContain('needs a free developer app');
    expect(profile).toContain('Continue');
    expect(profile).toContain('in a browser shown right here');
  });

  it('Instructions: one line is a paragraph, several are a list', () => {
    expect(html(<Instructions text="Just one step" />)).toBe('<p class="small">Just one step</p>');
    expect(html(<Instructions text="" />)).toBe('');
  });
});

describe('settings tabs (static render)', () => {
  const tls: TlsStatus = {
    mode: 'auto',
    source: 'self-signed',
    subject: '203.0.113.7',
    notAfter: '2027-10-11T00:00:00Z',
    fingerprint256: 'AB:CD:EF',
    publicIp: '203.0.113.7',
    lastError: 'HTTP-01 challenge failed: port 80 not reachable',
    nextRenewalAt: null,
  };

  it('HTTPS tab: fingerprint, guidance and last error', () => {
    const out = html(<HttpsTab tls={tls} onRefresh={noop} refreshing={false} />);
    expect(out).toContain('AB:CD:EF');
    expect(out).toContain('your browser will warn');
    expect(out).toContain('port 80 not reachable');
    expect(out).toContain('Never forward 1935');
    expect(out).toContain('PUBLIC_HOST');
    expect(out).toContain('TLS_MODE=off');
  });

  it('General tab shows the current values', () => {
    const data: SettingsResponse = {
      settings: { publicBaseUrl: 'https://203.0.113.7', ingestHost: '192.168.1.20', disconnectGraceSec: 15 },
      tls,
      version: '1.2.3',
    };
    const out = html(<GeneralTab data={data} onSaved={noop} />);
    expect(out).toContain('value="https://203.0.113.7"');
    expect(out).toContain('value="192.168.1.20"');
    expect(out).toContain('value="15"');
  });

  it('About tab shows the version', () => {
    expect(html(<AboutTab version="1.2.3" />)).toContain('1.2.3');
  });
});
