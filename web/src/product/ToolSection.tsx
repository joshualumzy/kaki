import { useEffect, useState } from 'react';
import { Button } from '../ui';
import {
  disconnectTool,
  saveTool,
  testTool,
  type ToolStatus,
  type WorkspaceDetail,
} from './api';

interface FieldSpec {
  name: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number';
  optional?: boolean;
}

interface ToolSpec {
  kind: string;
  label: string;
  tokenLabel?: string;
  tokenRequired?: boolean;
  fields: FieldSpec[];
}

const TOOLS: ToolSpec[] = [
  {
    kind: 'mattermost',
    label: 'Mattermost',
    tokenLabel: 'Bot token',
    tokenRequired: true,
    fields: [
      { name: 'url', label: 'Mattermost URL', placeholder: 'https://chat.example.com' },
      { name: 'team', label: 'Team' },
      { name: 'channel', label: 'Channel' },
    ],
  },
  {
    kind: 'gitea',
    label: 'Gitea',
    tokenLabel: 'Access token',
    tokenRequired: true,
    fields: [
      { name: 'url', label: 'Gitea URL', placeholder: 'https://gitea.example.com' },
      { name: 'owner', label: 'Organisation' },
      { name: 'repo', label: 'Repository' },
    ],
  },
  {
    kind: 'wiki',
    label: 'Wiki.js',
    tokenLabel: 'Password',
    tokenRequired: true,
    fields: [
      { name: 'url', label: 'Wiki URL', placeholder: 'https://wiki.example.com' },
      { name: 'email', label: 'Login email', type: 'text' },
      { name: 'prefix', label: 'Page path prefix', optional: true },
    ],
  },
  {
    kind: 'email',
    label: 'Email',
    fields: [
      { name: 'smtpHost', label: 'SMTP host' },
      { name: 'smtpPort', label: 'SMTP port', type: 'number' },
      { name: 'from', label: 'From address' },
      { name: 'mailpitUrl', label: 'Mailbox URL' },
    ],
  },
  {
    kind: 'calendar',
    label: 'Calendar',
    fields: [
      { name: 'caldavUrl', label: 'CalDAV URL' },
      { name: 'viewBaseUrl', label: 'View base URL', optional: true },
      { name: 'user', label: 'User', optional: true },
      { name: 'calendar', label: 'Calendar', optional: true },
    ],
  },
];

type FormState = Record<string, string>;

type RowResult = { ok: boolean; message: string };

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function blankForm(spec: ToolSpec): FormState {
  return Object.fromEntries(spec.fields.map((field) => [field.name, '']));
}

function formFrom(spec: ToolSpec, settings: Record<string, unknown>): FormState {
  return Object.fromEntries(spec.fields.map((field) => [field.name, text(settings[field.name])]));
}

function settingsFor(spec: ToolSpec, form: FormState): Record<string, unknown> {
  return Object.fromEntries(
    spec.fields.map((field) => [
      field.name,
      field.type === 'number' ? Number(form[field.name] ?? '') : (form[field.name] ?? '').trim(),
    ]),
  );
}

function statusText(tool: ToolStatus | undefined): string {
  if (tool === undefined) return 'Not connected';
  if (tool.connected) return 'Connected';
  if (tool.error !== undefined) return tool.error;
  return 'Not connected';
}

function ToolRow({
  workspaceId,
  spec,
  tool,
  canEdit,
  onChanged,
}: {
  workspaceId: string;
  spec: ToolSpec;
  tool: ToolStatus | undefined;
  canEdit: boolean;
  onChanged: (kind: string, next: ToolStatus | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm(spec));
  const [token, setToken] = useState('');
  const [result, setResult] = useState<RowResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'test' | 'save' | 'disconnect' | null>(null);

  useEffect(() => {
    if (open) return;
    setForm(tool === undefined ? blankForm(spec) : formFrom(spec, tool.settings));
    setToken('');
    setResult(null);
    setError(null);
  }, [tool, open, spec]);

  function startConnect(): void {
    setForm(tool === undefined ? blankForm(spec) : formFrom(spec, tool.settings));
    setToken('');
    setResult(null);
    setError(null);
    setOpen(true);
  }

  function tokenForRequest(): string | undefined {
    if (spec.tokenLabel === undefined) return undefined;
    if (token.trim() !== '') return token;
    return tool?.connected === true ? undefined : '';
  }

  async function runTest(): Promise<void> {
    if (pending !== null) return;
    setPending('test');
    setResult(null);
    setError(null);
    try {
      const outcome = await testTool(
        workspaceId,
        spec.kind,
        settingsFor(spec, form),
        tokenForRequest(),
      );
      setResult(outcome);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'Could not test the connection.');
    } finally {
      setPending(null);
    }
  }

  async function save(): Promise<void> {
    if (pending !== null) return;
    setPending('save');
    setResult(null);
    setError(null);
    try {
      const saved = await saveTool(
        workspaceId,
        spec.kind,
        settingsFor(spec, form),
        tokenForRequest(),
      );
      onChanged(spec.kind, saved);
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the connection.');
    } finally {
      setPending(null);
    }
  }

  async function disconnect(): Promise<void> {
    if (pending !== null) return;
    setPending('disconnect');
    setError(null);
    try {
      await disconnectTool(workspaceId, spec.kind);
      onChanged(spec.kind, null);
      setOpen(false);
    } catch (disconnectError) {
      setError(
        disconnectError instanceof Error ? disconnectError.message : 'Could not disconnect the tool.',
      );
    } finally {
      setPending(null);
    }
  }

  const connected = tool?.connected === true;

  return (
    <li className="product-tool">
      <div className="product-tool-head">
        <div>
          <p className="product-row-title">{spec.label}</p>
          <p
            className="product-tool-status"
            data-connected={connected}
            data-failed={tool?.error !== undefined}
          >
            {statusText(tool)}
          </p>
        </div>
        {canEdit ? (
          <div className="product-tool-actions">
            {open ? null : (
              <Button variant="ghost" onClick={startConnect}>
                {connected ? 'Edit' : 'Connect'}
              </Button>
            )}
            {connected ? (
              <Button variant="ghost" onClick={() => void disconnect()} disabled={pending !== null}>
                {pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {open && canEdit ? (
        <form
          className="product-tool-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {spec.fields.map((field) => (
            <label key={field.name} className="product-field">
              <span>{field.label}{field.optional === true ? ' (optional)' : ''}</span>
              <input
                className="product-input"
                type={field.type ?? 'text'}
                value={form[field.name] ?? ''}
                placeholder={field.placeholder ?? ''}
                onChange={(event) =>
                  setForm((current) => ({ ...current, [field.name]: event.target.value }))
                }
              />
            </label>
          ))}
          {spec.tokenLabel === undefined ? null : (
            <label className="product-field">
              <span>{spec.tokenLabel}{spec.tokenRequired === true ? '' : ' (optional)'}</span>
              <input
                className="product-input"
                type="password"
                value={token}
                autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
              />
              {connected ? (
                <span className="product-field-hint">Leave blank to keep the saved token.</span>
              ) : null}
            </label>
          )}
          {result === null ? null : (
            <p
              className={result.ok ? 'product-note' : 'product-error'}
              role={result.ok ? 'status' : 'alert'}
            >
              {result.message}
            </p>
          )}
          {error === null ? null : (
            <p className="product-error" role="alert">
              {error}
            </p>
          )}
          <div className="product-row-actions">
            <Button variant="ghost" onClick={() => void runTest()} disabled={pending !== null}>
              {pending === 'test' ? 'Testing…' : 'Test'}
            </Button>
            <Button type="submit" disabled={pending !== null}>
              {pending === 'save' ? 'Saving…' : 'Save'}
            </Button>
            <button type="button" className="product-link" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {error !== null && !open ? (
        <p className="product-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

interface ToolSectionProps {
  workspace: WorkspaceDetail;
  canEdit: boolean;
  onChange: (tools: ToolStatus[]) => void;
}

/** The workspace's tools: status for everyone, connect/test/save/disconnect for admins. */
export function ToolSection({ workspace, canEdit, onChange }: ToolSectionProps) {
  const [rows, setRows] = useState<ToolStatus[]>(workspace.tools);

  useEffect(() => {
    setRows(workspace.tools);
  }, [workspace.tools]);

  function changed(kind: string, next: ToolStatus | null): void {
    setRows((current) => {
      const without = current.filter((tool) => tool.kind !== kind);
      const updated =
        next === null ? without : [...without, next].sort((a, b) => a.kind.localeCompare(b.kind));
      onChange(updated);
      return updated;
    });
  }

  if (workspace.readOnly) {
    return (
      <section className="card product-section" aria-label="Tools">
        <h2 className="product-section-title">Tools</h2>
        <p className="product-note">This workspace is read-only; its tools are built in.</p>
        <ul className="product-tools">
          {TOOLS.map((spec) => (
            <li key={spec.kind} className="product-tool">
              <div className="product-tool-head">
                <div>
                  <p className="product-row-title">{spec.label}</p>
                  <p className="product-tool-status" data-connected="true">
                    Built in
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="card product-section" aria-label="Tools">
      <h2 className="product-section-title">Tools</h2>
      <p className="product-hint">
        Kaki uses these tools to read the workspace and to post what the meeting agreed.
      </p>
      <ul className="product-tools">
        {TOOLS.map((spec) => (
          <ToolRow
            key={spec.kind}
            workspaceId={workspace.id}
            spec={spec}
            tool={rows.find((tool) => tool.kind === spec.kind)}
            canEdit={canEdit}
            onChanged={changed}
          />
        ))}
      </ul>
    </section>
  );
}
