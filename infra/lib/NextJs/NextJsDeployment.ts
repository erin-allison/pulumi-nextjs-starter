import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { DistributionInvalidation } from "../DistributionInvalidation";
import { NextJsApplication } from "./NextJsApplication";

export interface NextJsDeploymentArgs {
  applications: { [key: string]: NextJsApplication };
}

export class NextJsDeployment extends pulumi.ComponentResource {
  applications: { [key: string]: NextJsApplication };
  distribution: aws.cloudfront.Distribution;

  constructor(
    name: string,
    args: NextJsDeploymentArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("cloud:index:NextJs:Deployment", name, {}, opts);

    this.applications = args.applications;

    const origins = pulumi
      .all(
        Object.entries(args.applications).map(([applicationId, application]) =>
          application.origins.apply((origins) => ({ origins, applicationId })),
        ),
      )
      .apply((list) => {
        return list.flatMap(({ applicationId, origins }) => {
          return origins.map((origin) => ({
            ...origin,
            originId: `${applicationId}-${origin.originId}`,
          }));
        });
      });

    const behaviors = pulumi
      .all(
        Object.entries(args.applications).map(([applicationId, application]) =>
          application.behaviors.apply((behaviors) => ({
            behaviors,
            applicationId,
          })),
        ),
      )
      .apply((list) => {
        return list.flatMap(({ applicationId, behaviors }) => {
          return behaviors.map((behavior) => ({
            ...behavior,
            targetOriginId: `${applicationId}-${behavior.targetOriginId}`,
          }));
        });
      });

    this.distribution = new aws.cloudfront.Distribution(
      `${name}-distribution`,
      {
        origins,
        orderedCacheBehaviors: behaviors.apply(
          (behaviors) =>
            behaviors.filter((behavior) => behavior.pathPattern !== "*")!,
        ),
        defaultCacheBehavior: behaviors.apply((behaviors) => ({
          ...behaviors.find((behavior) => behavior.pathPattern === "*")!,
          pathPattern: undefined,
        })),

        enabled: true,
        httpVersion: "http2and3",
        isIpv6Enabled: true,
        priceClass: "PriceClass_100",

        restrictions: {
          geoRestriction: {
            restrictionType: "none",
          },
        },
        viewerCertificate: {
          cloudfrontDefaultCertificate: true,
        },
      },
      { parent: this },
    );

    const invalidationPolicy = new aws.iam.Policy(
      `${name}-distribution-invalidation_policy`,
      {
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Action: ["cloudfront:CreateInvalidation"],
              Effect: "Allow",
              Resource: [this.distribution.arn],
            },
          ],
        },
      },
      { parent: this },
    );

    const functionRoles = pulumi
      .all(
        Object.values(args.applications).map(
          (application) => application.functions,
        ),
      )
      .apply((functions) =>
        functions
          .flatMap((functions) =>
            Object.values(functions).map(
              ({ functionInstance }) => functionInstance,
            ),
          )
          .map((functionInstance) =>
            functionInstance.role.apply((role) => role.split("/")[1]!),
          ),
      );

    new aws.iam.PolicyAttachment(
      `${name}-distribution-invalidation_policy-attachment`,
      {
        policyArn: invalidationPolicy.arn,
        roles: functionRoles,
      },
      { parent: invalidationPolicy },
    );

    Object.entries(args.applications).map(([applicationId, application]) => {
      new aws.s3.BucketPolicy(
        `${name}-distribution-${applicationId}-bucket_policy`,
        {
          bucket: application.bucket.bucket,
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                Principal: aws.iam.Principals.CloudfrontPrincipal,
                Effect: "Allow",
                Action: "s3:GetObject",
                Resource: pulumi.interpolate`${application.bucket.arn}/*`,
                Condition: {
                  StringEquals: {
                    "AWS:SourceArn": this.distribution.arn,
                  },
                },
              },
            ],
          },
        },
        { parent: this.distribution },
      );
    });

    new DistributionInvalidation(
      `${name}-distribution-invalidation`,
      {
        distributionId: this.distribution.id,
        version: pulumi
          .all(
            Object.values(args.applications).map(
              (application) => application.buildId,
            ),
          )
          .apply((buildIds) => buildIds.join("/")),
      },
      { parent: this.distribution },
    );
  }
}

/*
createDistributionInvalidation();*/
