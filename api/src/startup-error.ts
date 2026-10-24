const connectionStringPattern = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;
const sensitiveAssignmentPattern =
  /((?:["']?[\w.-]*(?:password|passwd|pwd|secret|token|authorization|api[_-]?key|private[_-]?key)[\w.-]*["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi;

export function getSafeStartupErrorDetails(error: unknown): {
  errorName: string;
  errorCode?: string;
  errorMessage?: string;
} {
  if (!(error instanceof Error)) {
    return { errorName: "UnknownError" };
  }

  let errorMessage = error.message;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /(?:PASSWORD|SECRET|TOKEN|DATABASE_URL)/i.test(name)) {
      errorMessage = errorMessage.replaceAll(value, "[REDACTED]");
    }
  }
  errorMessage = errorMessage
    .replace(connectionStringPattern, "[REDACTED_URL]")
    .replace(sensitiveAssignmentPattern, '$1"[REDACTED]"');

  const errorCode =
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9]{5}$/.test(error.code)
      ? error.code
      : undefined;

  return {
    errorName: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : "Error",
    ...(errorCode ? { errorCode } : {}),
    errorMessage,
  };
}
