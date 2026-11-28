export interface AgentFiles {
  inputs: string[];
  output: string;
}

export interface ToolStep {
  id: string;
  kind: 'tool';
  label: string;
  status: 'running' | 'failed' | 'done';
}

export interface AgentTurnHost {
  onProgress?(snapshot: { steps: ToolStep[]; toolCount: number; updatedAt: number }): Promise<void>;
  sendNotice?(text: string, signal: AbortSignal): Promise<void>;
  askUser?(request: { question: string; options: string[] }, signal: AbortSignal): Promise<string[][]>;
  /** Resolve the requested path inside this turn's output directory and validate it before delivery. */
  emitArtifact?(
    artifact: { path: string; name?: string; mimeType?: string },
    signal: AbortSignal,
  ): Promise<void>;
}
