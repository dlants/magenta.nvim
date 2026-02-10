import { generatePKCE } from "@openauthjs/openauth/pkce";
import fs from "fs/promises";
import path from "path";
import os from "os";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface OAuthTokens {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

interface AuthData {
  anthropic?: OAuthTokens;
}

export class ExchangeFailed extends Error {
  constructor() {
    super("Exchange failed");
  }
}

function getDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) {
    return path.join(xdgDataHome, "magenta");
  }
  return path.join(os.homedir(), ".local", "share", "magenta");
}

function getAuthFilePath(): string {
  return path.join(getDataDir(), "auth.json");
}

export async function loadTokens(): Promise<OAuthTokens | undefined> {
  try {
    const filePath = getAuthFilePath();
    const data = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(data) as AuthData;
    const tokens = json.anthropic;
    return tokens?.type === "oauth" ? tokens : undefined;
  } catch {
    return undefined;
  }
}

export async function storeTokens(tokens: OAuthTokens): Promise<void> {
  const filePath = getAuthFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let data: AuthData = {};
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    data = JSON.parse(existing) as AuthData;
  } catch {
    // File doesn't exist or is invalid, start fresh
  }
  data.anthropic = tokens;
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function clearTokens(): Promise<void> {
  const filePath = getAuthFilePath();
  try {
    const data = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(data) as AuthData;
    delete json.anthropic;
    await fs.writeFile(filePath, JSON.stringify(json, null, 2), {
      mode: 0o600,
    });
  } catch {
    // File doesn't exist or is invalid, nothing to clear
  }
}

export async function authorize(): Promise<{ url: string; verifier: string }> {
  const pkce = await generatePKCE();
  const url = new URL("https://claude.ai/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

export async function exchange(
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok) {
    throw new ExchangeFailed();
  }
  const json = (await result.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };
  return {
    type: "oauth",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function refresh(refreshToken: string): Promise<OAuthTokens> {
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) {
    throw new ExchangeFailed();
  }
  const json = (await response.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };
  return {
    type: "oauth",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function getAccessToken(): Promise<string | undefined> {
  const tokens = await loadTokens();
  if (!tokens) {
    return undefined;
  }
  if (tokens.expires > Date.now() + 5 * 60 * 1000) {
    return tokens.access;
  }
  try {
    const newTokens = await refresh(tokens.refresh);
    await storeTokens(newTokens);
    return newTokens.access;
  } catch {
    await clearTokens();
    return undefined;
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const accessToken = await getAccessToken();
  return accessToken !== undefined;
}
