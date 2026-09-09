import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Builds an AWS home with an sso-session profile whose cached token is
 * expired and un-refreshable, which is the state `aws sso login` leaves behind
 * once a session lapses. The SSO cache is keyed by a sha1 of the session name
 * and is looked up relative to $HOME, so tests point HOME at this directory. */
function writeExpiredSsoHome(): { home: string; configFile: string } {
  const home = mkdtempSync(join(tmpdir(), "magenta-sso-"));
  const cacheDir = join(home, ".aws", "sso", "cache");
  mkdirSync(cacheDir, { recursive: true });
  const sessionName = "FakeSession";
  const cacheKey = createHash("sha1").update(sessionName).digest("hex");
  writeFileSync(
    join(cacheDir, `${cacheKey}.json`),
    JSON.stringify({
      startUrl: "https://example.awsapps.com/start",
      region: "us-east-1",
      accessToken: "expired-token",
      expiresAt: "2020-01-01T00:00:00Z",
    }),
  );
  const configFile = join(home, ".aws", "config");
  writeFileSync(
    configFile,
    [
      "[profile fake]",
      `sso_session = ${sessionName}`,
      "sso_account_id = 123456789012",
      "sso_role_name = FakeRole",
      "",
      `[sso-session ${sessionName}]`,
      "sso_start_url = https://example.awsapps.com/start",
      "sso_region = us-east-1",
      "sso_registration_scopes = sso:account:access",
      "",
    ].join("\n"),
  );
  return { home, configFile };
}

/** Points the AWS SDK at that home for the duration of one test; restore
 * `process.env` in an afterEach. */
export function useExpiredSsoEnv(): void {
  const { home, configFile } = writeExpiredSsoHome();
  process.env.HOME = home;
  process.env.AWS_CONFIG_FILE = configFile;
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(home, ".aws", "credentials");
}
