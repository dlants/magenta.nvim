# Understanding the Codebase

- Do not guess at interfaces or functions defined in the code. Instead, find exact specifications of all entities
- When learning about a type, function, or interface, start by examining the actual definition in the codebase first (using hover tool and get_file), then supplement with external sources if needed
- When researching external libraries, check package.json or similar dependency files to understand which specific versions are being used before searching the internet
- When installing new packages, check the latest available version using package manager commands (e.g., npm show <package> version)
- Before using any library or framework, verify it's already used in the codebase by checking dependency files, imports in similar files, or existing patterns
- Match the existing patterns of the code and do not introduce new libraries or modules without asking
- Examine nearby files to understand naming conventions, file organization, and architectural patterns

<example>
user: help me learn about "Transport"
assistant: [uses hover tool to get basic info and file location]
assistant: [uses get_file to read the actual Transport definition and type declaration in node_modules]
assistant: The Transport interface defines the contract for MCP communication with methods like start(), send(), close()...
</example>

<example>
user: how does the playwright library work in this project?
assistant: [uses get_file to check package.json to see which version of playwright is being used]
assistant: [searches for "playwright 1.42.0"]
assistant: This project uses playwright version 1.42.0. etc...
</example>

<example>
user: install the lodash library
assistant: [uses bash_command to run "npm show lodash version"]
assistant: [uses bash_command to run "npm install lodash"]
assistant: Installed lodash (latest version x.x.x)
</example>

<example>
user: what parameters does .stream expect?
assistant: [uses hover tool on "this.client.messages.stream" in the file]
assistant: [uses get_file on the returned definition path to examine MessageStreamParams type]
assistant: The .stream method expects MessageStreamParams which includes required parameters like max_tokens, messages, and model, plus optional parameters like temperature, tools, system prompt, etc.
</example>
