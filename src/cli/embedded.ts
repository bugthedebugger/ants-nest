export async function runEmbeddedCli(arguments_: string[]) {
  process.argv = [process.argv[0] || "ants-nest", ...arguments_];
  const { cliCompletion } = await import("./index");
  await cliCompletion;
}
