// Deterministic validator for the narrow JSON Schema (2020-12) subset actually
// used by this repository's contracts: type (single or ["x","null"]), const,
// enum, pattern, format: date-time, minLength, minimum, maximum, minItems,
// items, required, properties, additionalProperties. It walks the schema
// itself rather than re-encoding schema rules by hand for specific fields, so
// a schema edit changes validation behavior without a matching code edit.

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(type, value) {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isValidDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  return true;
}

function validateNode(schema, value, path, errors) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${path}: expected type ${types.join(" or ")} but received ${describeValue(value)}`);
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected constant value ${JSON.stringify(schema.const)}, received ${JSON.stringify(value)}`);
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, received ${JSON.stringify(value)}`);
  }

  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must have length >= ${schema.minLength}`);
    }
    if (schema.format === "date-time" && !isValidDateTime(value)) {
      errors.push(`${path}: "${value}" is not a valid RFC 3339 date-time string`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} item(s)`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${path}: unexpected additional property "${key}"`);
        }
      }
    }
    for (const key of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(properties[key], value[key], `${path}.${key}`, errors);
      }
    }
  }
}

export function validateAgainstSchema(schema, value, rootPath = "$") {
  const errors = [];
  validateNode(schema, value, rootPath, errors);
  return errors;
}

export function assertValidAgainstSchema(schema, value, label) {
  const errors = validateAgainstSchema(schema, value);
  if (errors.length > 0) {
    throw new Error(`${label} failed schema validation:\n- ${errors.join("\n- ")}`);
  }
}
