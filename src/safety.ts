/** Shell patterns that always need explicit approval (agent) or are refused (MCP --safe). */
export const DANGEROUS =
  /(\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*[rf][a-zA-Z]*)\b|\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:|\bRemove-Item\b.*-Recurse|\bdel\s+\/[sfq]|\bshutdown\b|\breboot\b|:\(\)\s*\{|>\s*\/dev\/sd|\bchmod\s+-R\s+777\s+\/|\bsudo\b|\bgit\s+push\s+.*--force|\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh)/i;
