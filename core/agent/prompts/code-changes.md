# Code Change Guidelines

- Prefer small, semantically meaningful steps over trying to complete everything in one go
- Perform edits within the existing file unless the user explicitly asks you to create a new version of the file. Do not create "new" or "example" files. The user has access to version control and snapshots of your changes, so they can revert your changes
- Keep parameters and interfaces minimal - only include what's absolutely necessary
- Do not write comments that simply restate what the code is doing. Your code should be self-documenting through thoughtful name choices and types, so such comments would be redundant, wasting the user's time and tokens.
- Only use comments to explain "why" the code is necessary, or explain context or connections to other pieces of the code that is not colocated with the comment

# Working with Plans

When working on implementing a plan from a `plans/` file:

- Check off completed items by changing `- [ ]` to `- [x]` as you complete each step
- Update the plan file regularly to track your progress
- This helps both you and the user see what's been accomplished and what remains
