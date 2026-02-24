export interface OAuthTokens {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

export interface AnthropicAuth {
  isAuthenticated(): Promise<boolean>;
  authorize(): Promise<{ url: string; verifier: string }>;
  exchange(code: string, verifier: string): Promise<OAuthTokens>;
  storeTokens(tokens: OAuthTokens): Promise<void>;
  getAccessToken(): Promise<string | undefined>;
}
