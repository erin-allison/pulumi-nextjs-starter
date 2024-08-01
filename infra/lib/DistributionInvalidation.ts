import * as pulumi from "@pulumi/pulumi";

import {
  CloudFrontClient,
  CreateInvalidationCommand,
  waitUntilInvalidationCompleted,
} from "@aws-sdk/client-cloudfront";

export interface DistributionInvalidationInputs {
  distributionId: pulumi.Input<Inputs["distributionId"]>;
  version: pulumi.Input<Inputs["version"]>;
}

interface Inputs {
  distributionId: string;
  version: string;
}

async function handle(inputs: Inputs) {
  const client = new CloudFrontClient();
  const result = await client.send(
    new CreateInvalidationCommand({
      DistributionId: inputs.distributionId,
      InvalidationBatch: {
        CallerReference: Date.now().toString(),
        Paths: {
          Quantity: 1,
          Items: ["/*"],
        },
      },
    }),
  );
  const invalidationId = result.Invalidation?.Id;

  if (!invalidationId) {
    throw new Error("Invalidation ID not found");
  }

  try {
    await waitUntilInvalidationCompleted(
      {
        client,
        maxWaitTime: 600,
      },
      {
        DistributionId: inputs.distributionId,
        Id: invalidationId,
      },
    );
  } catch (e) {
    // suppress errors
    // console.error(e);
  }
}

const distributionInvalidationProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: Inputs) {
    await handle(inputs);
    return { id: "invalidation" };
  },
  async update(id: string, olds: Inputs, news: Inputs) {
    await handle(news);
    return {};
  },
};

export class DistributionInvalidation extends pulumi.dynamic.Resource {
  constructor(
    name: string,
    args: DistributionInvalidationInputs,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(distributionInvalidationProvider, name, args, opts);
  }
}
