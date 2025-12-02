---
name: doc-views
description: Comprehensive guide for the view system in magenta.nvim, including template literal syntax, component composition, interactive bindings, and TUI-specific rendering patterns
---

# View System in magenta.nvim

**THIS IS NOT REACT**. **DO NOT USE REACT VIEWS OR DOM**. This uses a templating library for a TUI running inside a neovim buffer.

Views in magenta.nvim are built using a declarative templating approach with the `d` template literal tag and view functions that render controller state to neovim buffers.

## Core Concepts

The view system is based on several key principles:

1. **Declarative rendering**: Views describe what should be displayed, not how to update the buffer
2. **Template composition**: Small view functions combine to build complex UIs
3. **Interactive bindings**: Attach keybindings to specific regions of rendered text
4. **Automatic updates**: Views re-render on state changes triggered by dispatched messages

## Template Literal Syntax (`d`)

The `d` tag function is the foundation of the view system:

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

### Interpolation Rules

- String values are inserted as-is
- Other `d` templates can be nested
- Arrays of `d` templates are joined together
- Undefined/null values render as empty strings
- Numbers are converted to strings

## Component Composition

Break down complex views into smaller, reusable functions:

```typescript
function headerView(title: string) {
  return d`
===================
${title}
===================
`;
}

function itemView(item: Item) {
  return d`
- ${item.name}: ${item.description}
  Status: ${item.status}
`;
}

function listView(items: Item[]) {
  return d`
${headerView("My Items")}

${items.map((item) => itemView(item))}
`;
}
```

## Adding Interactivity with `withBindings`

Attach keybindings to sections of text using `withBindings`:

```typescript
withBindings(d`Press Enter to continue`, {
  "<CR>": () => dispatch({ type: "continue" }),
  q: () => dispatch({ type: "quit" }),
});
```

### Multiple Bindings

You can attach multiple keybindings to the same text region:

```typescript
withBindings(d`[Submit]`, {
  "<CR>": () => dispatch({ type: "submit" }),
  "<Space>": () => dispatch({ type: "submit" }),
  s: () => dispatch({ type: "submit" }),
});
```

### Bindings on Lists

Each item in a list can have its own bindings:

```typescript
d`
${items.map((item, index) =>
  withBindings(d`[${index + 1}] ${item.name}\n`, {
    "<CR>": () => dispatch({ type: "select-item", index }),
    d: () => dispatch({ type: "delete-item", index }),
  }),
)}
`;
```

## Controller View Methods

Controllers implement a `view()` method that returns their rendered state:

```typescript
class MyController {
  state: {
    count: number;
    items: string[];
  };

  view() {
    return d`
Counter: ${this.state.count}

${withBindings(d`[Increment]`, {
  "<CR>": () => this.myDispatch({ type: "increment" }),
})}

Items:
${this.state.items.map((item) => d`- ${item}\n`)}
`;
  }
}
```

## Rendering Cycle

1. User action triggers a keybinding or command
2. Binding dispatches a message
3. Message flows through the dispatch system to the appropriate controller
4. Controller updates its state
5. View is re-rendered based on new state
6. Buffer content is updated with new view

## TUI-Specific Considerations

### Text Alignment and Spacing

Unlike web UIs, TUI rendering requires careful attention to spacing:

```typescript
// Good: Explicit newlines for vertical spacing
d`
Line 1
Line 2

Line 4 (with gap above)
`;

// Bad: Implicit spacing assumptions
d`Line 1${"\n"}Line 2`; // Hard to read
```

### Buffer Width

Be aware that text may wrap based on terminal/buffer width:

```typescript
// Consider line length when formatting
d`
This is a very long line that might wrap in narrow terminals
Consider breaking long text into multiple lines
`;
```

### Visual Separators

Use ASCII art for visual structure:

```typescript
d`
===================
Section Header
===================

Content goes here

-------------------

Footer
`;
```

## Common Patterns

### Loading States

```typescript
view() {
  if (this.state.loading) {
    return d`Loading...`;
  }

  return d`
${this.state.data}

${withBindings(d`[Refresh]`, {
  "<CR>": () => this.myDispatch({ type: "refresh" }),
})}
`;
}
```

### Error Display

```typescript
view() {
  if (this.state.error) {
    return d`
ERROR: ${this.state.error.message}

${withBindings(d`[Retry]`, {
  "<CR>": () => this.myDispatch({ type: "retry" }),
})}
`;
  }

  // Normal view...
}
```

### Conditional Sections

```typescript
view() {
  return d`
Main content

${this.state.showDetails ? d`
Details:
${this.state.details}
` : d``}

${withBindings(d`[${this.state.showDetails ? "Hide" : "Show"} Details]`, {
  "<CR>": () => this.myDispatch({ type: "toggle-details" }),
})}
`;
}
```

### Lists with Actions

```typescript
view() {
  return d`
Tasks:

${this.state.tasks.map((task, idx) => d`
${withBindings(d`[${task.done ? "✓" : " "}] ${task.name}`, {
  "<CR>": () => this.myDispatch({ type: "toggle-task", index: idx }),
  d: () => this.myDispatch({ type: "delete-task", index: idx }),
})}
`)}

${withBindings(d`[Add Task]`, {
  "<CR>": () => this.myDispatch({ type: "add-task" }),
})}
`;
}
```

### Multi-Column Layouts

Use spacing to create columns:

```typescript
function formatRow(name: string, value: string) {
  const nameWidth = 20;
  const paddedName = name.padEnd(nameWidth);
  return d`${paddedName} ${value}`;
}

view() {
  return d`
${formatRow("Name:", this.state.name)}
${formatRow("Status:", this.state.status)}
${formatRow("Created:", this.state.created)}
`;
}
```

## Best Practices

### Keep Views Pure

Views should be pure functions of state - no side effects:

```typescript
// Good: Pure view function
view() {
  return d`Count: ${this.state.count}`;
}

// Bad: Side effects in view
view() {
  this.logCount(); // Don't do this!
  return d`Count: ${this.state.count}`;
}
```

### Extract Complex Logic

Don't put complex logic in templates:

```typescript
// Good: Extract to helper method
private formatItem(item: Item): string {
  return `${item.name} (${item.status})`;
}

view() {
  return d`${this.state.items.map((item) => d`${this.formatItem(item)}\n`)}`;
}

// Bad: Complex logic in template
view() {
  return d`${this.state.items.map((item) => d`${item.name} (${item.done ? "✓" : item.pending ? "..." : "✗"})\n`)}`;
}
```

### Use Descriptive Binding Labels

Make interactive elements obvious:

```typescript
// Good: Clear interactive elements
withBindings(d`[ Submit ]`, { "<CR>": handler });
withBindings(d`Press Enter to continue`, { "<CR>": handler });

// Bad: Unclear what's interactive
withBindings(d`Submit`, { "<CR>": handler });
withBindings(d`>`, { "<CR>": handler });
```

### Handle Empty States

Always consider what happens with empty data:

```typescript
view() {
  if (this.state.items.length === 0) {
    return d`
No items found.

${withBindings(d`[Add Item]`, {
  "<CR>": () => this.myDispatch({ type: "add" }),
})}
`;
  }

  return d`${this.state.items.map(/* ... */)}`;
}
```

### Avoid Deep Nesting

Keep template nesting shallow for readability:

```typescript
// Good: Flat structure with helper functions
view() {
  return d`
${this.renderHeader()}
${this.renderContent()}
${this.renderFooter()}
`;
}

// Bad: Deep nesting
view() {
  return d`
${this.state.show ? d`
  ${this.state.loading ? d`
    Loading...
  ` : d`
    ${this.state.items.map((item) => d`
      ${item.visible ? d`${item.name}` : d``}
    `)}
  `}
` : d``}
`;
}
```

## Debugging Views

### Check Rendered Output

The view is rendered to a neovim buffer - you can inspect the actual buffer content to debug rendering issues:

```typescript
// In tests
const bufferContent = await driver.getDisplayBuffer();
console.log(bufferContent);
```

### Validate Bindings

Ensure bindings are attached to the correct regions:

```typescript
// In tests
const pos = await driver.assertDisplayBufferContains("[Submit]");
await driver.triggerDisplayBufferKey(pos, "<CR>");
```

### Log State

Add temporary logging to see state during rendering:

```typescript
view() {
  this.context.nvim.logger.debug("Rendering with state:", this.state);
  return d`...`;
}
```

## Performance Considerations

### Minimize Re-renders

Only dispatch messages when state actually changes:

```typescript
// Good: Check before updating
myUpdate(msg: Msg) {
  if (msg.type === "set-filter") {
    if (this.state.filter !== msg.filter) {
      this.state.filter = msg.filter;
      // View will re-render
    }
  }
}

// Bad: Always update
myUpdate(msg: Msg) {
  if (msg.type === "set-filter") {
    this.state.filter = msg.filter; // Re-renders even if same value
  }
}
```

### Avoid Expensive Computations in Views

Compute derived data in update methods, not in views:

```typescript
// Good: Pre-compute in update
myUpdate(msg: Msg) {
  this.state.items = msg.items;
  this.state.filteredItems = this.state.items.filter(/* ... */);
}

view() {
  return d`${this.state.filteredItems.map(/* ... */)}`;
}

// Bad: Compute in view
view() {
  const filtered = this.state.items.filter(/* expensive filter */);
  return d`${filtered.map(/* ... */)}`;
}
```

## Common Pitfalls

### Don't Mix String Concatenation with `d`

```typescript
// Bad: Mixing strings
d`Hello ` + userName; // Wrong!

// Good: Use interpolation
d`Hello ${userName}`;
```

### Don't Forget Newlines in Lists

```typescript
// Bad: Items will run together
d`${items.map((item) => d`${item.name}`)}`;

// Good: Explicit newlines
d`${items.map((item) => d`${item.name}\n`)}`;
```

### Don't Return Plain Strings

```typescript
// Bad: Plain string
view() {
  return "Hello"; // Won't work!
}

// Good: Use d template
view() {
  return d`Hello`;
}
```

### Don't Mutate State in View

```typescript
// Bad: Side effects
view() {
  this.state.viewCount++; // Never do this!
  return d`Viewed ${this.state.viewCount} times`;
}

// Good: Pure view
view() {
  return d`Viewed ${this.state.viewCount} times`;
}
```
