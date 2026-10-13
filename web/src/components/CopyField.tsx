import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from '../state/toast';
import { Button } from './Button';
import { Field } from './Field';
import { TextInput } from './TextInput';
import { copyText } from './utils';

export interface CopyFieldProps {
  value: string;
  label?: ReactNode;
  help?: ReactNode;
  /** Mask the value until "Show" is pressed (copy still copies the real value). */
  secret?: boolean;
  /** Monospace (default true). */
  mono?: boolean;
  id?: string;
  className?: string;
}

const MASK = '••••••••••••••••';

/** Read-only value with a copy button (and optional reveal for secrets). */
export function CopyField({ value, label, help, secret = false, mono = true, id, className }: CopyFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const hidden = secret && !revealed;
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error('Copy failed. Select the text and copy it manually.');
    }
  };

  const control = (
    <div className={className ? `copy-field ${className}` : 'copy-field'}>
      <TextInput
        id={label ? undefined : id}
        readOnly
        mono={mono}
        value={hidden ? MASK : value}
        aria-label={label ? undefined : 'Value'}
        spellCheck={false}
        onFocus={(e) => {
          if (!hidden) e.currentTarget.select();
        }}
      />
      {secret && (
        <Button size="sm" variant="ghost" onClick={() => setRevealed((r) => !r)} aria-pressed={revealed}>
          {revealed ? 'Hide' : 'Show'}
        </Button>
      )}
      <Button size="sm" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );

  if (!label) return control;
  return (
    <Field label={label} help={help} id={id}>
      {control}
    </Field>
  );
}
