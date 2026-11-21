import type { ToolProbeResult } from '../action/probe';
import type { WorkspaceToolKind } from './tools';

/** A tool call that could not list its targets; the route shows this message unchanged. */
export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}
import { calendarConnector } from './connectors/calendar';
import { emailConnector } from './connectors/email';
import { giteaConnector } from './connectors/gitea';
import { mattermostConnector } from './connectors/mattermost';
import { wikiConnector } from './connectors/wiki';

/** One selectable place a tool can send to: a channel, a repository or a wiki path prefix. */
export interface ConnectorTarget {
  id: string;
  label: string;
}

/** What every tool kind must offer, whatever the tool is. */
export interface ToolConnector {
  kind: WorkspaceToolKind;
  /** Keep only the non-secret fields this tool understands, or say what is missing. */
  normalizeSettings(
    value: unknown,
  ): { ok: true; settings: Record<string, unknown> } | { ok: false; error: string };
  /** Check the address and credentials work. */
  test(settings: Record<string, unknown>, token: string): Promise<ToolProbeResult>;
  /** List the places this tool can send to. */
  listTargets(settings: Record<string, unknown>, token: string): Promise<ConnectorTarget[]>;
  /** The target chosen in settings, when the tool has one, so a test proves it still exists. */
  targetRef(settings: Record<string, unknown>): string | undefined;
}

const CONNECTORS: Record<WorkspaceToolKind, ToolConnector> = {
  mattermost: mattermostConnector,
  gitea: giteaConnector,
  wiki: wikiConnector,
  email: emailConnector,
  calendar: calendarConnector,
};

/** The connector that owns every bit of tool-specific behaviour for one kind. */
export function connectorFor(kind: WorkspaceToolKind): ToolConnector {
  return CONNECTORS[kind];
}
