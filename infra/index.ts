import { NextJsApplication } from "./lib/NextJs/NextJsApplication";
import { NextJsDeployment } from "./lib/NextJs/NextJsDeployment";

const deployment = new NextJsDeployment("deployment", {
  applications: {
    docs: new NextJsApplication("docs", {
      packageName: "docs",
    }),
    web: new NextJsApplication("web", {
      packageName: "web",
    }),
  },
});

const deploymentOutput = {
  url: deployment.distribution.domainName,
};

export { deploymentOutput as deployment };
