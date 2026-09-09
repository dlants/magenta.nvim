export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

export function formatTokenCount(tokens: number): string {
  return tokens >= 1000
    ? `~${Math.round(tokens / 1000).toString()}k tok`
    : `~${tokens.toString()} tok`;
}

export function formatTokens(charCount: number): string {
  return formatTokenCount(estimateTokens(charCount));
}
