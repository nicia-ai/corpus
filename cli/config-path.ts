import { isAbsolute, join } from "node:path";

export function corpusConfigPath(
  environment: Readonly<{
    CORPUS_CONFIG?: string;
    XDG_CONFIG_HOME?: string;
    LOCALAPPDATA?: string;
  }>,
  home: string,
  operatingSystem: NodeJS.Platform,
): string {
  if (environment.CORPUS_CONFIG !== undefined) {
    return environment.CORPUS_CONFIG;
  }
  const xdgRoot = environment.XDG_CONFIG_HOME;
  if (xdgRoot !== undefined && xdgRoot.trim() !== "" && isAbsolute(xdgRoot)) {
    return join(xdgRoot, "corpus", "config.json");
  }
  if (operatingSystem === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    const root =
      localAppData !== undefined &&
      localAppData.trim() !== "" &&
      isAbsolute(localAppData)
        ? localAppData
        : join(home, "AppData", "Local");
    return join(root, "Corpus", "config.json");
  }
  return join(home, ".config", "corpus", "config.json");
}
