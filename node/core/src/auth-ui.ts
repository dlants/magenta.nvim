export interface AuthUI {
  showOAuthFlow(authUrl: string): Promise<string>;
}
