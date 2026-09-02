function collectObjectSchemas(node, path, results) {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") {
    results.push({ node, path });
  }
  if (node.properties) {
    for (const [key, sub] of Object.entries(node.properties)) {
      collectObjectSchemas(sub, `${path}.properties.${key}`, results);
    }
  }
  if (node.items) {
    collectObjectSchemas(node.items, `${path}.items`, results);
  }
}

/**
 * Walks every properties/items subschema (not just the root) and requires
 * additionalProperties: false on each object-typed node, so a nested schema
 * cannot be relaxed to accept unknown fields without governance noticing.
 */
export function assertRecursiveFailClosed(schema, label) {
  const results = [];
  collectObjectSchemas(schema, "<root>", results);
  const violations = results.filter(({ node }) => node.additionalProperties !== false);
  if (violations.length > 0) {
    throw new Error(
      `${label} must set additionalProperties: false on every nested object schema; missing at: ${violations
        .map((v) => v.path)
        .join(", ")}`,
    );
  }
}
