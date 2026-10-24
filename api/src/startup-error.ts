const postgresCodePattern = /^[0-9A-Z]{5}$/;
const postgresIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function readStringProperty(value: object, key: string): string | undefined {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property && typeof property.value === "string"
    ? property.value
    : undefined;
}

export function getSafeStartupErrorDetails(error: unknown): {
  errorName: string;
  errorCode?: string;
  constraintName?: string;
  schemaName?: string;
  tableName?: string;
} {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError" };
  }

  let errorCode: string | undefined;
  let constraintName: string | undefined;
  let schemaName: string | undefined;
  let tableName: string | undefined;
  let current: unknown = error;
  const visited = new Set<object>();

  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (visited.has(current)) break;
    visited.add(current);

    const code = readStringProperty(current, "code");
    if (!errorCode && code && postgresCodePattern.test(code)) errorCode = code;

    const constraint = readStringProperty(current, "constraint");
    if (!constraintName && constraint && postgresIdentifierPattern.test(constraint)) {
      constraintName = constraint;
    }

    const schema = readStringProperty(current, "schema");
    if (!schemaName && schema && postgresIdentifierPattern.test(schema)) schemaName = schema;

    const table = readStringProperty(current, "table");
    if (!tableName && table && postgresIdentifierPattern.test(table)) tableName = table;

    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }

  return {
    errorName: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : "Error",
    ...(errorCode ? { errorCode } : {}),
    ...(constraintName ? { constraintName } : {}),
    ...(schemaName ? { schemaName } : {}),
    ...(tableName ? { tableName } : {}),
  };
}
