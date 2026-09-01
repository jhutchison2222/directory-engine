const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isValidDateTime(value) {
  if (typeof value !== "string") return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
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
      throw new Error(`json-schema-lite: unsupported schema type "${type}"`);
  }
}

function describePath(path) {
  return path.length === 0 ? "<root>" : path.join(".");
}

/**
 * Validates `value` against a narrow subset of JSON Schema (draft 2020-12)
 * sufficient for this repository's governance contracts: type, const, enum,
 * pattern, format: date-time, minLength, minItems, items, minimum, maximum,
 * properties, required, and additionalProperties. Returns a list of human
 * readable error strings; an empty list means the value is valid.
 */
export function validateAgainstSchema(schema, value, path = []) {
  const errors = [];

  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (value !== schema.const) {
      errors.push(
        `${describePath(path)}: expected constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
      );
    }
    return errors;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${describePath(path)}: expected type ${types.join(" or ")}, got ${JSON.stringify(value)}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${describePath(path)}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${describePath(path)}: does not match pattern ${schema.pattern}`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${describePath(path)}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.format === "date-time" && !isValidDateTime(value)) {
      errors.push(`${describePath(path)}: is not a valid RFC 3339 date-time`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${describePath(path)}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${describePath(path)}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${describePath(path)}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(schema.items, item, [...path, String(index)]));
      });
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${describePath(path)}: missing required property "${key}"`);
      }
    }
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...validateAgainstSchema(properties[key], value[key], [...path, key]));
      } else if (schema.additionalProperties === false) {
        errors.push(`${describePath(path)}: unexpected additional property "${key}"`);
      }
    }
  }

  return errors;
}

export function assertValidAgainstSchema(schema, value, label) {
  const errors = validateAgainstSchema(schema, value);
  if (errors.length > 0) {
    throw new Error(`${label} failed schema validation:\n- ${errors.join("\n- ")}`);
  }
}
