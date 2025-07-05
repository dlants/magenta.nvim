I want to make the following changes:

- refactor the tool views to split the view into:
  - a tool summary
  - an optional tool preview
- do not save stops on the message, or show stops on the message, when the stop corresponds to a tool request content. Instead, save the stop info on the toolDetailsExpanded map in message.ts.

- update message.ts to show the tool according to this logic:
  - if showDetails is false, show the summary of the request followed by the preview
  - if showDetails is true, show an expanded view of the request. Show the request summary, skip the request preview, then the JSON input, then the full request result, using renderContentValue from node/providers/helpers.ts
  - if showDetails is true and stop information is available, show the stop reason and usage summary after the tool request, but before the tool result
