import * as childProcess from "node:child_process";
import * as path from "node:path";

export const runProc: (
  ...params: Parameters<typeof childProcess.spawn>
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> = (...params) => {
  return new Promise((resolve, reject) => {
    try {
      const child = childProcess.spawn(...params);

      const stdout: string[] = [];
      const stderr: string[] = [];

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", function (data) {
        data = data.toString();
        stdout.push(data);
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", function (data) {
        data = data.toString();
        stderr.push(data);
      });

      child.on("close", function (exitCode) {
        resolve({
          stdout: stdout.join("\n").trim(),
          stderr: stderr.join("\n").trim(),
          exitCode,
        });
      });
    } catch (e) {
      reject(e);
    }
  });
};

export async function resolvePaths(packageName: string | Promise<string>) {
  const fullWorkspaceList: { name: string; path: string }[] = await runProc(
    "pnpm",
    ["multi", "ls", "--depth", "-1", "--json"],
    {},
  ).then(({ exitCode, stdout, stderr }) => {
    if (exitCode !== 0) {
      throw new Error(
        `Error loading workspace details from \`pnpm\`: ${stderr}`,
      );
    }
    return JSON.parse(stdout);
  });

  const awaitedPackageName = await packageName;

  const packageAbsolutePath = fullWorkspaceList.find(
    (p) => p.name === awaitedPackageName,
  )?.path;

  if (!packageAbsolutePath) {
    throw new Error(`Unable to locate package \`${awaitedPackageName}\``);
  }

  const packageRelativePath = path.relative(
    path.resolve(process.cwd(), ".."),
    packageAbsolutePath,
  );

  return {
    packageAbsolutePath,
    packageRelativePath,
  };
}
