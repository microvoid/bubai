import type { AgentProgressStep } from '@buzz-botmux/botmux-client';
import type { PermissionMode } from '../config';

export interface StreamEvent {
  session?: string;
  result?: string;
  error?: string;
  steps?: Partial<AgentProgressStep>[];
}
export interface CliAdapter {
  args(permission: PermissionMode, session?: string): string[];
  parse(record: Record<string, any>): StreamEvent;
}
