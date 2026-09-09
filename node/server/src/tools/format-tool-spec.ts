import type { ProviderToolSpec } from "../providers/provider-types.ts";

const INDENT = "  ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(
  node: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

function getStringArray(
  node: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = node[key];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
}

function indentText(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function describeType(node: Record<string, unknown>): string {
  const enumValues = node.enum;
  if (Array.isArray(enumValues)) {
    return `enum(${enumValues.map((v) => JSON.stringify(v)).join(", ")})`;
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      return key;
    }
  }
  const type = getString(node, "type");
  if (type) {
    return type;
  }
  return "unknown";
}

function formatSchemaNode(schema: unknown, indent: string): string {
  if (!isRecord(schema)) {
    return `${indent}${JSON.stringify(schema)}`;
  }

  const lines: string[] = [];
  lines.push(`${indent}(${describeType(schema)})`);

  const description = getString(schema, "description");
  if (description !== undefined) {
    lines.push(indentText(description, `${indent}${INDENT}`));
  }

  const type = getString(schema, "type");

  if (type === "object" && isRecord(schema.properties)) {
    const properties = schema.properties;
    const required = getStringArray(schema, "required") ?? [];
    lines.push(`${indent}Parameters:`);
    for (const [propName, propSchema] of Object.entries(properties)) {
      const isRequired = required.includes(propName);
      lines.push(
        `${indent}${INDENT}${propName}${isRequired ? ", required" : ""}:`,
      );
      lines.push(formatSchemaNode(propSchema, `${indent}${INDENT}${INDENT}`));
    }
  } else if (type === "array" && schema.items !== undefined) {
    lines.push(`${indent}${INDENT}items:`);
    lines.push(formatSchemaNode(schema.items, `${indent}${INDENT}${INDENT}`));
  } else {
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const variants = schema[key];
      if (Array.isArray(variants)) {
        lines.push(`${indent}${INDENT}${key}:`);
        for (const variant of variants) {
          lines.push(formatSchemaNode(variant, `${indent}${INDENT}${INDENT}`));
        }
      }
    }
  }

  return lines.join("\n");
}

export function formatToolSpec(spec: ProviderToolSpec): string {
  const lines: string[] = [];
  lines.push(`## ${spec.name}`);
  lines.push("");
  lines.push(spec.description);
  lines.push("");
  lines.push(formatSchemaNode(spec.input_schema, INDENT));
  return lines.join("\n");
}

export function formatToolSpecs(specs: ProviderToolSpec[]): string {
  return specs.map(formatToolSpec).join("\n\n");
}
