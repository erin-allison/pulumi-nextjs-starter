const config = {
  default: {},
  buildCommand: "exit 0", // in my example we set up Nx task distribution to handle the order of building.
  buildOutputPath: ".",
  appPath: ".",
  packageJsonPath: "../../", // again, path to the root of your repo (where the package.json is)
};

export default config;
