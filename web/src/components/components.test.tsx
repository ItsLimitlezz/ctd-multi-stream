import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage, FieldSpec } from '@shared/types';
import { Badge } from './Badge';
import { Button } from './Button';
import { ChatLog } from './ChatLog';
import { ConfirmButton } from './ConfirmButton';
import { CopyField } from './CopyField';
import { DynamicForm } from './DynamicForm';
import { EmptyState } from './EmptyState';
import { Field } from './Field';
import { PhaseBadge, PHASE_META } from './PhaseBadge';
import { PlatformBadge, platformMeta } from './PlatformBadge';
import { Tabs } from './Tabs';
import { TextInput } from './TextInput';
import { Toggle } from './Toggle';
import { safeHexColor, safeHttpUrl } from './utils';

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe('components (static render)', () => {
  it('Button: variants and loading state', () => {
    const out = html(
      <Button variant="danger" size="sm" loading>
        Delete
      </Button>,
    );
    expect(out).toContain('btn btn-danger btn-sm');
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('type="button"');
  });

  it('Field wires label, help and error to the control', () => {
    const out = html(
      <Field label="Name" id="name" help="Your name" error="Required">
        <TextInput value="" readOnly />
      </Field>,
    );
    expect(out).toContain('for="name"');
    expect(out).toContain('id="name"');
    expect(out).toContain('aria-describedby="name-error name-help"');
    expect(out).toContain('aria-invalid="true"');
  });

  it('Toggle renders an accessible switch', () => {
    const out = html(<Toggle checked onChange={() => undefined} aria-label="Enable" />);
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('aria-label="Enable"');
  });

  it('PlatformBadge uses brand colors and initials', () => {
    const out = html(<PlatformBadge platform="kick" withName />);
    expect(out).toContain('background:#53FC18');
    expect(out).toContain('>K<');
    expect(out).toContain('Kick');
    expect(platformMeta('twitch').color).toBe('#9146FF');
    expect(platformMeta('mystery').name).toBe('mystery');
  });

  it('PhaseBadge covers every phase', () => {
    expect(html(<PhaseBadge phase="live" />)).toContain('tone-live');
    expect(html(<PhaseBadge phase="error" />)).toContain('Error');
    expect(Object.keys(PHASE_META)).toHaveLength(10);
  });

  it('Badge, EmptyState and Tabs render', () => {
    expect(html(<Badge tone="success" dot>On</Badge>)).toContain('badge tone-success');
    expect(html(<EmptyState title="Nothing" description="Here" />)).toContain('Nothing');
    const tabs = html(<Tabs tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} value="b" onChange={() => undefined} idPrefix="t" />);
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toMatch(/id="t-tab-b"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="t-tab-b"/);
  });

  it('ConfirmButton starts unarmed', () => {
    const out = html(<ConfirmButton onConfirm={() => undefined}>End stream</ConfirmButton>);
    expect(out).toContain('End stream');
    expect(out).not.toContain('Click again');
  });

  it('CopyField masks secrets until revealed', () => {
    const out = html(<CopyField value="live_abc123" secret />);
    expect(out).not.toContain('live_abc123');
    expect(out).toContain('Show');
    expect(html(<CopyField value="rtmp://host/live" />)).toContain('rtmp://host/live');
  });

  it('DynamicForm renders every field type and hides stored secrets', () => {
    const fields: FieldSpec[] = [
      { key: 'server', label: 'Server', type: 'url', required: true },
      { key: 'key', label: 'Stream key', type: 'secret', required: true },
      { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'Alpha' }] },
      { key: 'on', label: 'Enabled', type: 'boolean' },
      { key: 'n', label: 'Count', type: 'number' },
      { key: 't', label: 'Text', type: 'text', help: 'Some help' },
    ];
    const out = html(
      <DynamicForm
        fields={fields}
        values={{ server: 'rtmp://x/y', mode: 'a', on: true, n: 3, t: 'hello' }}
        onChange={() => undefined}
        secretsSet={{ key: true }}
        errors={{ server: 'Bad URL' }}
        idPrefix="f"
      />,
    );
    expect(out).toContain('type="url"');
    expect(out).toContain('value="rtmp://x/y"');
    expect(out).toContain('•••• set');
    expect(out).toContain('Change');
    expect(out).toContain('Alpha');
    expect(out).toContain('role="switch"');
    expect(out).toContain('value="3"');
    expect(out).toContain('Some help');
    expect(out).toContain('Bad URL');
    expect(out).toContain('id="f-server"');

    // Without a stored value the secret is a password input that password managers should ignore.
    const fresh = html(<DynamicForm fields={fields.slice(1, 2)} values={{}} onChange={() => undefined} />);
    expect(fresh).toContain('type="password"');
    expect(fresh).toMatch(/autocomplete="new-password"/i);
    expect(fresh).toContain('data-1p-ignore="true"');
  });

  it('ChatLog renders text as plain text (no HTML injection)', () => {
    const msg: ChatMessage = {
      id: '1',
      platform: 'youtube',
      destinationId: 'd',
      author: { name: '<b>bob</b>', color: 'red;background:url(x)', badges: ['mod'] },
      text: '<img src=x onerror=alert(1)>',
      ts: '2026-10-11T10:00:00.000Z',
      kind: 'message',
    };
    const out = html(<ChatLog messages={[msg]} />);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;b&gt;bob&lt;/b&gt;');
    expect(out).not.toContain('url(x)');
    expect(out).toContain('mod');
    expect(html(<ChatLog messages={[]} emptyText="Quiet" />)).toContain('Quiet');
  });

  it('URL and color sanitizers', () => {
    expect(safeHttpUrl('https://twitch.tv/x')).toBe('https://twitch.tv/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHexColor('#FF00aa')).toBe('#FF00aa');
    expect(safeHexColor('red')).toBeNull();
    expect(safeHexColor('#fff;background:url(x)')).toBeNull();
  });
});
