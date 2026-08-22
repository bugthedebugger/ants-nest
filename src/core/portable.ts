export function portableExecutablePath() {
  if (process.platform !== "win32") return undefined;
  const value = process.env.PORTABLE_EXECUTABLE_FILE?.trim();
  return value ? value : undefined;
}

export function isPortableWindows() {
  return portableExecutablePath() !== undefined;
}
