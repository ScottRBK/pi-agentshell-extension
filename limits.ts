export interface AgentShellLimits {
  maxOutputBytes: number;
  maxProtocolBytes: number;
  maxMessageBytes: number;
  maxStderrBytes: number;
}

export const DEFAULT_AGENT_SHELL_LIMITS: AgentShellLimits = {
  maxOutputBytes: 64 * 1024,
  maxProtocolBytes: 2 * 1024 * 1024,
  maxMessageBytes: 256 * 1024,
  maxStderrBytes: 256 * 1024,
};
