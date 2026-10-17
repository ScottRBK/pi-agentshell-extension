export interface AgentShellLimits {
  max_output_bytes: number;
  max_protocol_bytes: number;
  max_message_bytes: number;
  max_stderr_bytes: number;
}

export const DEFAULT_AGENT_SHELL_LIMITS: AgentShellLimits = {
  max_output_bytes: 64 * 1024,
  max_protocol_bytes: 2 * 1024 * 1024,
  max_message_bytes: 256 * 1024,
  max_stderr_bytes: 256 * 1024,
};
