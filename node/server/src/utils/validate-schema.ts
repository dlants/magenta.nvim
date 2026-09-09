/**
 * Minimal, dependency-free JSON Schema validator. Covers the subset that
 * magenta scripts use to describe their parameters: `type` (object, array,
 * string, number, integer, boolean, null — single or union), `properties`,
 * `required`, `items`, `enum`, and `additionalProperties: false`. Returns a
 * list of human-readable error strings; an empty list means the value is valid.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "$",
): string[] {
  const errors: string[] = [];

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) {
      errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
      return errors;
    }
  }

  const type = schema.type;
  if (typeof type === "string" || Array.isArray(type)) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(
        `${path}: expected type ${types.join("|")} but got ${jsTypeOf(value)}`,
      );
      return errors;
    }
  }

  if (matchesType(value, "object") && isPlainObject(value)) {
    const obj = value;
    const required = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`${path}.${key}: required property is missing`);
      }
    }
    const props = isPlainObject(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        errors.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          errors.push(`${path}.${key}: unexpected property`);
        }
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    const itemSchema = schema.items as Record<string, unknown>;
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, itemSchema, `${path}[${i}]`));
    });
  }

  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // Unknown type keyword — don't block.
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
