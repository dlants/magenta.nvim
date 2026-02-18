---
name: plan
description: Guide for creating implementation plans. Use when breaking down complex work into actionable steps.
---

# Planning Process

When creating a plan for a complex task:

## Architecting the solution

- Study similar features in the codebase and follow their patterns
- Prefer simple, minimal data structures over complex ones
- Avoid premature optimization. In situations where performance isn't critical, prefer an approach that's easier to understand.
  - For example, when preparing a network request, you're already dealing with something that's on the order of 100ms. You can recompute request arguments rather than creating state to cache them.
  - When introducing state or a cache, consider whether the performance gained from storing these is worth the complexity of maintaining them.
- Focus on getting a clear solution of the core problem first, leaving performance and other considerations until later.

## Write the plan

Write the plan to `plans/<planName>.md`, then yield to the parent with the location of the plan file.

- start with a #context section
  - briefly restate the objective
  - Explicitly define key types and interfaces
  - List relevant files with brief descriptions
- then add an #implementation section
  - Provide concrete, discrete implementation steps
  - Each step should be minimal, and keep the project functional
  - Include "Iterate until you get no compilation/type errors" steps between major component implementations
  - Include "Write tests and iterate until tests pass" steps between major component implementations
  - add a markdown checkbox in front of each step and sub-step, so we can check things off as we go along

<example>
# context
The goal is to implement a new feature [feature description].

The relevant files and entities are:
[file 1]: [why is this file relevant]
[interface]: [why is it relevant]
[class]: why is it relevant]
[file 2]: [why is this file relevant]
... etc...

# implementation

- [ ] amend [interface] to include a new field {[fieldname]: [fieldtype]}
  - [ ] check all references of the interface to accomodate the new field
  - [ ] check for type errors and iterate until they pass
- [ ] write a helper class [class] that performs [function] using [algorithm]
  - [ ] write the class
  - [ ] write unit tests
  - [ ] iterate until unit tests pass
        ... etc...
        </example>

## Learning Phase

Before writing the plan, you may need to learn about relevant parts of the codebase. Follow the learning process:

1. Identify all of the functions, objects and types that you may need to know about in order to complete the task
2. List all of the entities by name
3. Explicitly state: "X, Y and Z seem relevant. I will try and learn about them."
4. Use the hover tool on each entity to see its signature and declaration location
5. If the signature is ambiguous or insufficient, look at the declaration
6. Repeat until you have learned about all of the relevant interfaces

<example>
user: learn about how to implement feature X in the code
assistant: myFunction1 and myFunction2 seem relevant. I will try to learn about them.
[uses hover tool on myFunction1 - shows it's a function in myFile that accepts an opaque MyType argument]
[uses hover tool on myFunction2]
[since myFile is not part of the context, uses get_file to look at myFile to see full function implementation and where MyType is imported from]
MyType seems relevant. I will try to learn about it.
[uses hover on MyType]
[... and so on, until all relevant interfaces have been gathered ...]
</example>

# Working with Plans

When working on implementing a plan from a `plans/` file:

- Check off completed items by changing `- [ ]` to `- [x]` as you complete each step
- Update the plan file regularly to track your progress
- This helps both you and the user see what's been accomplished and what remains
