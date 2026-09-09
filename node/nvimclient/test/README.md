# Testing with Recording/Replay

This directory contains provider implementations and their tests. The tests use a recording/replay system to ensure consistent behavior without requiring live API access.

## How the Recording/Replay System Works

The test system can operate in two modes:

### Recording Mode

Set the environment variable `RECORD=true` to enable recording mode:

```bash
RECORD=true npx vitest run node/nvimclient/providers/copilot.test.ts
```

In recording mode:

- Tests make real network requests to the actual APIs
- All HTTP interactions are captured and saved to JSON files in `node/nvimclient/providers/recordings/`
- You need valid OAuth tokens configured for this to work
- Each test creates its own recording file named after the test

### Replay Mode (Default)

Without the environment variable, tests run in replay mode:

```bash
npx vitest run node/nvimclient/providers/copilot.test.ts
```

In replay mode:

- Tests use the previously recorded HTTP interactions
- No real network requests are made
- Tests are fast and deterministic
- No authentication is required

## Recording File Structure

Each test creates a recording file with this structure:

```json
{
  "testName": "simple-text-response",
  "interactions": [
    {
      "request": {
        "method": "GET",
        "url": "https://api.github.com/copilot_internal/v2/token",
        "headers": {
          "Authorization": "token gho_..."
        }
      },
      "response": {
        "statusCode": 200,
        "headers": {
          "content-type": "application/json"
        },
        "body": "{\"token\":\"ghs_...\",\"endpoints\":{\"api\":\"https://api.githubcopilot.com\"}}"
      }
    }
  ]
}
```

## Updating Tests

When you need to update a test or the provider behavior:

1. Delete the relevant recording file from `node/nvimclient/providers/recordings/`
2. Run the test in recording mode to capture new interactions
3. The test will now use the new recording in subsequent runs

## Best Practices

- Keep test scenarios focused and minimal
- Use descriptive test names since they become recording filenames
- Don't commit sensitive tokens or data in recordings
- Use the `withRecording()` helper for tests that need network access
- Regular unit tests (like tool compatibility) don't need recordings

## Authentication for Recording

When running in recording mode, you need valid GitHub Copilot credentials. The system looks for:

1. `~/.config/github-copilot/hosts.json` - OAuth token from GitHub CLI
2. `~/.config/github-copilot/apps.json` - Direct Copilot token

Make sure you have GitHub Copilot access and have run `gh auth login` or have the appropriate token files.
