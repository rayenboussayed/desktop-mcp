/**
 * Checks whether a shell command is dangerous enough to always require explicit approval.
 * @param command - Command line to inspect.
 * @returns Whether the command should be treated as dangerous.
 */
function isDangerous(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const has = (needle: string): boolean => command.toLowerCase().includes(needle.toLowerCase());
  const hasAny = (needles: readonly string[]): boolean => needles.some(has);

  if (tokens.some((t) => /^-[a-z]*[rf]/i.test(t))) {
    if (tokens[0]?.toLowerCase() === "rm") return true;
  }
  if (hasAny(["mkfs", "format ", "del /s", "del /q", "reboot", "shutdown", "sudo", "chmod -r 777 /", "> /dev/sd", "git push"])) {
    if (has("mkfs")) return true;
    if (has("format ")) return true;
    if (has("del /s") || has("del /q")) return true;
    if (has("shutdown")) return true;
    if (has("reboot")) return true;
    if (has("sudo")) return true;
    if (has("chmod -r 777 /")) return true;
    if (has("> /dev/sd")) return true;
    if (has("git push") && has("--force")) return true;
  }
  if (has("dd if=")) return true;
  if (has("Remove-Item") && has("-Recurse")) return true;
  if (has(":()") || has(":(){ :|:& };:")) return true;
  if (has("curl ") && has("|") && (has("sh") || has("bash"))) return true;
  return command.toLowerCase().startsWith("chmod -r 777 /");
}

/**
 * Shell patterns that always need explicit approval (agent) or are refused (MCP --safe).
 */
export const DANGEROUS = {
  /**
   * Check a command line for dangerous patterns.
   * @param command - Command line to inspect.
   * @returns Whether the command should be treated as dangerous.
   */
  test(command: string): boolean {
    return isDangerous(command);
  },
} as const;

/**
 * Standalone predicate exported for callers that prefer a function over a regex-like object.
 * @param command - Command line to inspect.
 * @returns Whether the command should be treated as dangerous.
 */
export const dangerousCommand = isDangerous;
