---
name: create-skill
description: Guide for creating new skills in magenta.nvim, including file structure, frontmatter format, and TypeScript script execution
---

# Creating Skills for magenta.nvim

This guide explains how to create custom skills that extend Claude's capabilities in magenta.nvim.

## Skill Locations

Skills can be placed in several locations:

### Global Skills

- **Location**: `~/.magenta/skills/` or `~/.claude/skills/`
- **Usage**: Available across all projects
- **Use case**: General-purpose skills you want in every project
- **Note**: Both locations work identically; choose based on preference

### Project-Specific Skills

- **Location**: `.magenta/skills/` (in your project root)
- **Usage**: Only available in that specific project
- **Use case**: Project-specific workflows, conventions, or documentation

## Skill Structure

Each skill lives in its own subdirectory with a `skill.md` file:

```
~/.magenta/skills/
└── your-skill-name/
    ├── skill.md          # Required: main skill documentation
    └── scripts/          # Optional: executable scripts
        └── helper.ts     # Optional: TypeScript scripts
```

## skill.md Format

The `skill.md` file must include YAML frontmatter with required fields:

```markdown
---
name: your-skill-name
description: Brief description of what this skill does and when to use it
---

# Your Skill Documentation

Write your skill documentation here in markdown format.

This can include:

- Detailed explanations
- Code examples
- Best practices
- Step-by-step instructions
- References to other files or resources
```

### Required Frontmatter Fields

- **name**: Unique identifier for the skill (lowercase with hyphens recommended)
- **description**: Short description that gives the agent some hints as to the content of the full skill.md file.

## TypeScript Scripts in Skills

Skills can include executable TypeScript scripts using `pkgx` for zero-setup execution.

### What is pkgx?

[pkgx](https://pkgx.sh) is a package runner that automatically installs and runs packages on-demand without needing a full npm project setup. It's perfect for skill scripts since it eliminates boilerplate.

### Creating a Script

1. Create a `scripts/` directory in your skill folder
2. Add a `.ts` file with a pkgx shebang:

```typescript
#!/usr/bin/env -S pkgx +typescript +npx tsx

// Your TypeScript code here
console.log("Hello from a skill script!");

// You can use TypeScript features directly
interface Config {
  name: string;
  value: number;
}

const config: Config = {
  name: "example",
  value: 42,
};

console.log(config);
```

3. Make it executable and run:

```bash
chmod +x ~/.magenta/skills/your-skill-name/scripts/your-script.ts
./scripts/your-script.ts
```

Or run directly with pkgx:

```bash
pkgx +typescript npx tsx scripts/your-script.ts
```

### Running Shell Commands with zx

For scripts that need to run shell commands, use Google's `zx` library:

```typescript
#!/usr/bin/env -S pkgx +typescript +npx +zx tsx

import { $ } from "zx";

const result = await $`ls -la`;
console.log(result.stdout);
```

### Script Requirements

- **pkgx**: Install from https://pkgx.sh (`curl -Ssf https://pkgx.sh | sh`)
- No npm setup required - pkgx handles all dependencies automatically
