# View System in magenta.nvim

**THIS IS NOT REACT**. **DO NOT USE REACT VIEWS OR DOM** This uses a templating library for a TUI running inside a neovim buffer.

Views in magenta.nvim are built using a declarative templating approach:

## Template Literal and Composition

The `d` tag function is used for templates, similar to JSX but with template literals:

```typescript
// Basic text rendering
d`This is some text`;

// Dynamic content interpolation
d`User: ${username}`;

// Conditional rendering
d`${isLoading ? d`Loading...` : d`Content loaded!`}`;

// Rendering lists
d`${items.map((item) => d`- ${item.name}\n`)}`;

// Component composition
d`Header: ${headerView({ title })}\nBody: ${bodyView({ content })}`;
```

## Adding Interactivity

You can attach keybindings to sections of text with `withBindings`:

```typescript
withBindings(d`Press Enter to continue`, {
  "<CR>": () => dispatch({ type: "continue" }),
  q: () => dispatch({ type: "quit" }),
});
```

Views render to a neovim buffer and update on every dispatch.
