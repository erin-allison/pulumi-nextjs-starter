import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { resolvePaths } from "./NextJsUtil";
import { OpenNextManifest } from "./OpenNextTypes";

import { glob } from "glob";
import mime from "mime";
import { NextConfig } from "next";
import Seven from "node-7z";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface NextJsApplicationArgs {
  packageName: pulumi.Input<string>;
  environment?: Record<string, pulumi.Input<string>>;
  serverPolicies?: pulumi.Input<pulumi.Input<aws.iam.Policy>[]>;
}

type BuildOutput = ReturnType<
  InstanceType<typeof NextJsApplication>["loadBuildOutput"]
>;

export class NextJsApplication extends pulumi.ComponentResource {
  readonly packageName: pulumi.Input<string>;
  readonly environment: Record<string, pulumi.Input<string>>;
  serverPolicies?: pulumi.Input<pulumi.Input<aws.iam.Policy>[]>;

  readonly basePath: pulumi.Output<string>;

  readonly buildId: pulumi.Output<string>;
  readonly bucket: aws.s3.Bucket;
  readonly origins: pulumi.Output<
    aws.types.input.cloudfront.DistributionOrigin[]
  >;
  readonly behaviors: pulumi.Output<
    aws.types.input.cloudfront.DistributionOrderedCacheBehavior[]
  >;
  readonly functions: pulumi.Output<
    Record<
      string,
      {
        functionInstance: aws.lambda.Function;
        functionUrl: aws.lambda.FunctionUrl;
      }
    >
  >;

  public constructor(
    name: string,
    args: NextJsApplicationArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("cloud:index:NextJs:Application", name, {}, opts);

    const buildOutput = this.loadBuildOutput({ packageName: args.packageName });
    const nextConfig = this.loadNextConfig({ buildOutput });

    const basePath = nextConfig.apply(
      (nextConfig) => nextConfig.basePath ?? "/",
    );

    const bucket = this.createBucket({ name, buildOutput });

    const { lambdaOriginAccessControl, s3OriginAccessControl } =
      this.createOriginAccessControls({ name });
    const revalidationQueue = this.createRevalidationQueue({
      name,
      buildOutput,
    });
    const revalidationTable = this.createRevalidationTable({
      name,
      buildOutput,
    });
    this.createRevalidationTableSeeder({
      name,
      buildOutput,
      revalidationTable,
    });
    this.uploadAssets({
      name,
      buildOutput,
      basePath,
      bucket,
    });
    const cfFunction = this.createCloudFrontFunction({ name, basePath });

    /**
     * We expect this to error if any are defined. I'm not building/testing that
     * at this point in time
     */
    const edgeFunctions = this.createEdgeFunctions({ name, buildOutput });

    // TODO add custom environment
    // TODO add custom permissions
    const ssrFunctions = this.createSSRFunctions({
      name,
      buildOutput,
      bucket,
      revalidationQueue,
      revalidationTable,
      originAccessControl: lambdaOriginAccessControl,
    });

    const origins = this.buildOrigins({
      name,
      buildOutput,
      bucket,
      functions: { ...edgeFunctions, ...ssrFunctions },
      lambdaOriginAccessControl,
      s3OriginAccessControl,
    });

    const behaviors = this.buildBehaviors({
      name,
      buildOutput,
      basePath,
      cfFunction,
    });

    // TODO add warmer function
    // createWarmer();

    this.functions = { ...edgeFunctions, ...ssrFunctions };
    this.origins = origins;
    this.behaviors = behaviors;

    this.buildId = buildOutput.buildId.apply((buildId) => buildId.toString());
    this.packageName = args.packageName;
    this.environment = args.environment ?? {};
    this.serverPolicies = args.serverPolicies ?? [];
    this.basePath = basePath;

    this.bucket = bucket;

    this.registerOutputs({
      packageName: this.packageName,
      buildId: this.buildId,
      environment: this.environment,
      basePath: this.basePath,
      bucket: this.bucket,
      origins: this.origins,
      behaviors: this.behaviors,
      functions: this.functions,
    });
  }

  private loadBuildOutput(props: { packageName: pulumi.Input<string> }) {
    return pulumi.output(props.packageName).apply(async (packageName) => {
      const { packageAbsolutePath, packageRelativePath } =
        await resolvePaths(packageName);

      const manifest = JSON.parse(
        (
          await fs.readFile(
            path.join(packageAbsolutePath, ".open-next/open-next.output.json"),
          )
        ).toString(),
      ) as OpenNextManifest;

      if (Object.keys(manifest.edgeFunctions).length > 0) {
        throw new Error("Edge functions are not supported");
      }

      return {
        awsRegion: await aws.getRegion({}),
        buildId: await fs.readFile(
          path.join(packageAbsolutePath, ".next/BUILD_ID"),
        ),
        manifest,
        packageName,
        packageAbsolutePath,
        packageRelativePath,
        prerenderManifest: JSON.parse(
          (
            await fs.readFile(
              path.join(packageAbsolutePath, ".next/prerender-manifest.json"),
            )
          ).toString(),
        ) as { routes: { [key: string]: unknown } },
      };
    });
  }

  private loadNextConfig(props: {
    buildOutput: BuildOutput;
  }): pulumi.Output<NextConfig> {
    return props.buildOutput.apply(async (buildOutput) => {
      const configPath = path.join(
        buildOutput.packageAbsolutePath,
        "next.config",
      );
      return (await import(configPath)).default as NextConfig;
    });
  }

  private createBucket(props: { name: string; buildOutput: BuildOutput }) {
    const bucket = new aws.s3.Bucket(
      `${props.name}-bucket`,
      {
        forceDestroy: true,
      },
      { parent: this },
    );

    new aws.s3.BucketPublicAccessBlock(
      `${props.name}-bucket-public_access_block`,
      {
        bucket: bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this },
    );

    return bucket;
  }
  private createRevalidationQueue(props: {
    name: string;
    buildOutput: BuildOutput;
  }) {
    return props.buildOutput.apply((buildOutput) => {
      if (buildOutput.manifest.additionalProps?.disableIncrementalCache) {
        return undefined;
      }

      const revalidationFunction =
        buildOutput.manifest.additionalProps?.revalidationFunction;
      if (!revalidationFunction) {
        return undefined;
      }

      const revalidationQueue = new aws.sqs.Queue(
        `${props.name}-revalidation-queue`,
        {
          fifoQueue: true,
          receiveWaitTimeSeconds: 20,
        },
        { parent: this },
      );

      const revalidationHandlerRole = new aws.iam.Role(
        `${props.name}-revalidation-handler-role`,
        {
          assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: "lambda.amazonaws.com",
          }),
          managedPolicyArns: [
            aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
          ],
        },
        { parent: this },
      );

      new aws.iam.RolePolicy(
        `${props.name}-revalidation-handler-role-policy`,
        {
          role: revalidationHandlerRole,
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                Action: [
                  "sqs:ChangeMessageVisibility",
                  "sqs:DeleteMessage",
                  "sqs:GetQueueAttributes",
                  "sqs:GetQueueUrl",
                  "sqs:ReceiveMessage",
                ],
                Effect: "Allow",
                Resource: [revalidationQueue.arn],
              },
            ],
          },
        },
        { parent: revalidationHandlerRole },
      );

      const revalidationHandler = new aws.lambda.Function(
        `${props.name}-revalidation-handler`,
        {
          description: `${props.name} ISR Revalidation Handler`,
          handler: revalidationFunction.handler,
          code: new pulumi.asset.FileArchive(
            path.join(
              buildOutput.packageAbsolutePath,
              revalidationFunction.bundle,
            ),
          ),
          runtime: aws.lambda.Runtime.NodeJS20dX,
          memorySize: 1024,
          timeout: 10,
          architectures: ["arm64"],

          role: revalidationHandlerRole.arn,
        },
        { parent: this },
      );

      new aws.sqs.QueueEventSubscription(
        `${props.name}-revalidation-queue-subscription`,
        revalidationQueue,
        revalidationHandler,
        { batchSize: 5 },
        { parent: this },
      );

      return revalidationQueue;
    });
  }
  private createRevalidationTable(props: {
    name: string;
    buildOutput: BuildOutput;
  }) {
    return props.buildOutput.apply((buildOutput) => {
      if (buildOutput.manifest.additionalProps?.disableTagCache) {
        return undefined;
      }

      return new aws.dynamodb.Table(
        `${props.name}-revalidation-table`,
        {
          attributes: [
            { name: "tag", type: "S" },
            { name: "path", type: "S" },
            { name: "revalidatedAt", type: "N" },
          ],
          hashKey: "tag",
          rangeKey: "path",
          pointInTimeRecovery: {
            enabled: true,
          },
          billingMode: "PAY_PER_REQUEST",
          globalSecondaryIndexes: [
            {
              name: "revalidate",
              hashKey: "path",
              rangeKey: "revalidatedAt",
              projectionType: "ALL",
            },
          ],
        },
        { parent: this },
      );
    });
  }
  private createRevalidationTableSeeder(props: {
    name: string;
    buildOutput: BuildOutput;
    revalidationTable: pulumi.Input<aws.dynamodb.Table | undefined>;
  }) {
    return pulumi
      .all([props.buildOutput, props.revalidationTable])
      .apply(([buildOutput, revalidationTable]) => {
        if (buildOutput.manifest.additionalProps?.disableTagCache) {
          return;
        }
        const seederFunction =
          buildOutput.manifest.additionalProps?.initializationFunction;
        if (!seederFunction) {
          return;
        }

        const prerenderedRoutesCount = Object.keys(
          buildOutput.prerenderManifest.routes,
        ).length;

        const revalidationTableSeederRole = new aws.iam.Role(
          `${props.name}-revalidation-table-seeder-role`,
          {
            assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
              Service: "lambda.amazonaws.com",
            }),
            managedPolicyArns: [
              aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
            ],
          },
          { parent: this },
        );

        new aws.iam.RolePolicy(
          `${props.name}-revalidation-table-seeder-role-policy`,
          {
            role: revalidationTableSeederRole,
            policy: {
              Version: "2012-10-17",
              Statement: [
                {
                  Action: [
                    "dynamodb:BatchWriteItem",
                    "dynamodb:PutItem",
                    "dynamodb:DescribeTable",
                  ],
                  Effect: "Allow",
                  Resource: [revalidationTable!.arn],
                },
              ],
            },
          },
          { parent: revalidationTableSeederRole },
        );

        new aws.lambda.Function(
          `${props.name}-revalidation-table-seeder`,
          {
            description: `${props.name} ISR Revalidation Seeder`,
            handler: seederFunction.handler,
            code: new pulumi.asset.FileArchive(
              path.join(buildOutput.packageAbsolutePath, seederFunction.bundle),
            ),
            runtime: aws.lambda.Runtime.NodeJS20dX,
            memorySize: Math.min(
              10240,
              Math.max(128, Math.ceil(prerenderedRoutesCount / 4000) * 128),
            ),
            timeout: 900,
            environment: {
              variables: {
                CACHE_DYNAMO_TABLE: revalidationTable!.name,
              },
            },

            role: revalidationTableSeederRole.arn,
          },
          { parent: this },
        );
      });
  }

  private uploadAssets(props: {
    name: string;
    buildOutput: BuildOutput;
    basePath: pulumi.Input<string>;
    bucket: pulumi.Input<aws.s3.Bucket>;
  }) {
    // Define content headers
    const versionedFilesTTL = 31536000; // 1 year
    const nonVersionedFilesTTL = 86400; // 1 day

    const cacheControl = (versioned: boolean) =>
      versioned
        ? `public,max-age=${versionedFilesTTL},immutable`
        : `public,max-age=0,s-maxage=${nonVersionedFilesTTL},stale-wile-revalidate=${nonVersionedFilesTTL}`;

    return pulumi
      .all([props.buildOutput, props.basePath, props.bucket])
      .apply(async ([buildOutput, basePath, bucket]) => {
        const origin = buildOutput.manifest.origins.s3;

        origin.copy.map(async (copyConfig) => {
          const copyFrom = copyConfig.from;
          const copyTo = copyConfig.to;

          /**
           * This is necessary to properly handle setting the cacheControl variable
           * for sites using a non-root base path. OpenNext generates `versionedSubDir`
           * as e.g. `<basePath>/_next` when only `_next` exists in the build folder.
           */
          const versionedSubDir =
            copyConfig.versionedSubDir &&
            copyConfig.versionedSubDir.startsWith(basePath.substring(1) + "/")
              ? copyConfig.versionedSubDir.replace(
                  basePath.substring(1) + "/",
                  "",
                )
              : copyConfig.versionedSubDir;

          const rootPath = path.resolve(
            buildOutput.packageAbsolutePath,
            copyFrom,
          );

          const unversionedFiles = glob
            .glob("**", {
              cwd: rootPath,
              ignore: versionedSubDir
                ? path.join(versionedSubDir, "**")
                : undefined,
              dot: true,
              nodir: true,
              follow: true,
            })
            .then((files) =>
              files.map((file) => ({
                file,
                versioned: false,
              })),
            );

          const versionedFiles = versionedSubDir
            ? glob
                .glob(path.join(versionedSubDir, "**"), {
                  cwd: rootPath,
                  dot: true,
                  nodir: true,
                  follow: true,
                })
                .then((files) =>
                  files.map((file) => ({
                    file,
                    versioned: true,
                  })),
                )
            : null;

          let allFiles = (
            await Promise.all([unversionedFiles, versionedFiles])
          ).flatMap((f) => f ?? []);

          return allFiles.map(
            ({ file, versioned }) =>
              new aws.s3.BucketObjectv2(
                `${props.name}-asset-${versioned ? "versioned" : "unversioned"}-${file}`,
                {
                  bucket: bucket,
                  key: path.join(copyTo, file),
                  source: new pulumi.asset.FileAsset(path.join(rootPath, file)),
                  cacheControl: cacheControl(versioned),
                  contentType: mime.getType(file) || undefined,
                  tags: {
                    originalName: path.join(copyFrom, file),
                  },
                },
                { parent: this },
              ),
          );
        });
      });
  }

  private createCloudFrontFunction(props: {
    name: string;
    basePath: pulumi.Output<string>;
  }) {
    return props.basePath.apply((basePath) => {
      return new aws.cloudfront.Function(
        `${props.name}-cloudfront-function`,
        {
          code: `
function handler(event) {
  var request = event.request;
  ${useCloudFrontFunctionHostHeaderInjection()}
  ${useCloudFrontFunctionCacheHeaderKey(props)}
  ${useCloudFrontGeoHeadersInjection()}
  ${basePath !== "/" ? useCloudFrontPathRewrite(basePath) : ""}
  return request;
}`,
          runtime: "cloudfront-js-1.0",
          publish: true,
        },
        { parent: this },
      );
    });

    function useCloudFrontFunctionCacheHeaderKey({ name }: { name: string }) {
      // This function is used to improve cache hit ratio by setting the cache key
      // based on the request headers and the path. `next/image` only needs the
      // accept header, and this header is not useful for the rest of the query
      return `
function getHeader(key) {
  var header = request.headers[key];
  if (header) {
    if (header.multiValue) {
      return header.multiValue.map((header) => header.value).join(",");
    }
    if (header.value) {
      return header.value;
    }
  }
  return "";
}
var cacheKey = "";
if (request.uri.startsWith("/_next/image")) {
  cacheKey =
    "${name}" +
    getHeader("accept");
} else {
  cacheKey =
    "${name}" +
    getHeader("rsc") +
    getHeader("next-router-prefetch") +
    getHeader("next-router-state-tree") +
    getHeader("next-url") +
    getHeader("x-prerender-revalidate");
}
if (request.cookies["__prerender_bypass"]) {
  cacheKey += request.cookies["__prerender_bypass"]
    ? request.cookies["__prerender_bypass"].value
    : "";
}
var crypto = require("crypto");

var hashedKey = crypto.createHash("md5").update(cacheKey).digest("hex");
request.headers["x-open-next-cache-key"] = { value: hashedKey };
`;
    }
    function useCloudFrontFunctionHostHeaderInjection() {
      return `request.headers["x-forwarded-host"] = request.headers.host;`;
    }
    function useCloudFrontGeoHeadersInjection() {
      // Inject the CloudFront viewer country, region, latitude, and longitude headers into the request headers
      // for OpenNext to use them
      return `
if(request.headers["cloudfront-viewer-city"]) {
  request.headers["x-open-next-city"] = request.headers["cloudfront-viewer-city"];
}
if(request.headers["cloudfront-viewer-country"]) {
  request.headers["x-open-next-country"] = request.headers["cloudfront-viewer-country"];
}
if(request.headers["cloudfront-viewer-region"]) {
  request.headers["x-open-next-region"] = request.headers["cloudfront-viewer-region"];
}
if(request.headers["cloudfront-viewer-latitude"]) {
  request.headers["x-open-next-latitude"] = request.headers["cloudfront-viewer-latitude"];
}
if(request.headers["cloudfront-viewer-longitude"]) {
  request.headers["x-open-next-longitude"] = request.headers["cloudfront-viewer-longitude"];
}
    `;
    }
    function useCloudFrontPathRewrite(basePath: string) {
      return `
if (request.uri.startsWith('${basePath}')) {
  request.uri = request.uri.replace("${basePath}", "")
}
if (request.uri === "") {
  request.uri = "/"
}`;
    }
  }

  private createEdgeFunctions(props: {
    name: string;
    buildOutput: BuildOutput;
  }) {
    return props.buildOutput.manifest.edgeFunctions.apply((edgeFunctions) => {
      if (Object.keys(edgeFunctions).length > 0) {
        throw new Error("Edge functions are not supported");
      }
      const ret: Record<
        string,
        {
          functionInstance: aws.lambda.Function;
          functionUrl: aws.lambda.FunctionUrl;
        }
      > = {};
      return ret;
    });
  }

  private createSSRFunctions(props: {
    name: string;
    buildOutput: BuildOutput;
    bucket: pulumi.Input<aws.s3.Bucket>;
    revalidationQueue: pulumi.Input<aws.sqs.Queue | undefined>;
    revalidationTable: pulumi.Input<aws.dynamodb.Table | undefined>;
    originAccessControl: pulumi.Input<aws.cloudfront.OriginAccessControl>;
  }) {
    return pulumi
      .all([
        props.buildOutput,
        props.bucket,
        props.revalidationQueue,
        props.revalidationTable,
        props.originAccessControl,
      ])
      .apply(
        ([
          buildOutput,
          bucket,
          revalidationQueue,
          revalidationTable,
          originAccessControl,
        ]) => {
          return Object.fromEntries(
            Object.entries(buildOutput.manifest.origins).flatMap(
              ([originId, originConfig]) => {
                if (originConfig.type !== "function") {
                  return [];
                }

                const role = new aws.iam.Role(
                  `${props.name}-origin-${originId}-role`,
                  {
                    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                      Service: "lambda.amazonaws.com",
                    }),
                    managedPolicyArns: [
                      aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
                    ],
                  },
                  { parent: this },
                );

                new aws.iam.RolePolicy(
                  `${props.name}-origin-${originId}-role-policy`,
                  {
                    role,
                    policy: {
                      Version: "2012-10-17",
                      Statement:
                        originId == "imageOptimizer"
                          ? [
                              {
                                Action: "s3:GetObject",
                                Effect: "Allow",
                                Resource: pulumi.interpolate`${bucket.arn}/*`,
                              },
                            ]
                          : [
                              {
                                Action: ["s3:GetObject", "s3:PutObject"],
                                Effect: "Allow",
                                Resource: pulumi.interpolate`${bucket.arn}/*`,
                              },
                              ...(revalidationQueue
                                ? [
                                    {
                                      Action: [
                                        "sqs:SendMessage",
                                        "sqs:GetQueueAttributes",
                                        "sqs:GetQueueUrl",
                                      ],
                                      Effect: "Allow" as const,
                                      Resource: revalidationQueue.arn,
                                    },
                                  ]
                                : []),
                              ...(revalidationTable
                                ? [
                                    {
                                      Action: [
                                        "dynamodb:BatchGetItem",
                                        "dynamodb:GetRecords",
                                        "dynamodb:GetShardIterator",
                                        "dynamodb:Query",
                                        "dynamodb:GetItem",
                                        "dynamodb:Scan",
                                        "dynamodb:ConditionCheckItem",
                                        "dynamodb:BatchWriteItem",
                                        "dynamodb:PutItem",
                                        "dynamodb:UpdateItem",
                                        "dynamodb:DeleteItem",
                                        "dynamodb:DescribeTable",
                                      ],
                                      Effect: "Allow" as const,
                                      Resource: [
                                        revalidationTable.arn,
                                        pulumi.interpolate`${revalidationTable.arn}/*`,
                                      ],
                                    },
                                  ]
                                : []),
                            ],
                    },
                  },
                  { parent: role },
                );
                const asset = new Promise<string>((resolve, reject) => {
                  const zipPath = `/tmp/${props.name}-SSR-${originId}-Function-${crypto.randomBytes(20).toString("hex").toUpperCase()}.zip`;

                  const zipStream = Seven.add(
                    zipPath,
                    path.join(
                      buildOutput.packageAbsolutePath,
                      originConfig.bundle,
                      "*",
                    ),
                  );

                  zipStream.on("end", () => resolve(zipPath));
                  zipStream.on("error", (err) => reject(err));
                });

                const ssrFunction = new aws.lambda.Function(
                  `${props.name}-origin-${originId}-function`,
                  {
                    description: `${props.name} SSR ${originId} Function`,
                    handler: originConfig.handler,
                    code: new pulumi.asset.FileArchive(asset),
                    runtime: aws.lambda.Runtime.NodeJS20dX,
                    environment: {
                      variables: {
                        BUCKET_NAME: bucket.bucket,
                        BUCKET_KEY_PREFIX: "_assets",
                        CACHE_BUCKET_NAME: bucket.bucket,
                        CACHE_BUCKET_KEY_PREFIX: "_cache",
                        CACHE_BUCKET_REGION: buildOutput.awsRegion.name,
                        ...(revalidationQueue && {
                          REVALIDATION_QUEUE_URL: revalidationQueue.url,
                          REVALIDATION_QUEUE_REGION: buildOutput.awsRegion.name,
                        }),
                        ...(revalidationTable && {
                          CACHE_DYNAMO_TABLE: revalidationTable.name,
                        }),
                      },
                    },
                    memorySize: 1024,
                    timeout: 30,
                    architectures: ["arm64"],
                    role: role.arn,
                  },
                  { parent: this },
                );

                return [
                  [
                    originId,
                    {
                      functionInstance: ssrFunction,
                      functionUrl: new aws.lambda.FunctionUrl(
                        `${props.name}-origin-${originId}-function-url`,
                        {
                          functionName: ssrFunction.name,
                          authorizationType: "NONE",

                          // TODO add a custom provider to add a policy to the function url
                          // for OAC support
                          //https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
                          //authorizationType: "AWS_IAM",
                        },
                        { parent: ssrFunction },
                      ),
                    },
                  ],
                ];
              },
            ),
          );
        },
      );
  }

  private createOriginAccessControls(props: { name: string }) {
    const lambdaOriginAccessControl = new aws.cloudfront.OriginAccessControl(
      `${props.name}-cloudfront-lambda_origin_access_control`,
      {
        originAccessControlOriginType: "lambda",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
      { parent: this },
    );
    const s3OriginAccessControl = new aws.cloudfront.OriginAccessControl(
      `${props.name}-cloudfront-s3_origin_access_control`,
      {
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
      { parent: this },
    );
    return { lambdaOriginAccessControl, s3OriginAccessControl };
  }

  private buildOrigins(props: {
    name: string;
    buildOutput: BuildOutput;
    bucket: pulumi.Input<aws.s3.Bucket>;
    functions: pulumi.Input<{
      [key: string]: { functionUrl: aws.lambda.FunctionUrl };
    }>;
    lambdaOriginAccessControl: pulumi.Input<aws.cloudfront.OriginAccessControl>;
    s3OriginAccessControl: pulumi.Input<aws.cloudfront.OriginAccessControl>;
  }) {
    return pulumi
      .all([
        props.buildOutput,
        props.bucket,
        props.functions,
        props.lambdaOriginAccessControl,
        props.s3OriginAccessControl,
      ])
      .apply(
        ([
          buildOutput,
          bucket,
          functions,
          lambdaOriginAccessControl,
          s3OriginAccessControl,
        ]) => {
          return Object.entries(buildOutput.manifest.origins).map(
            ([originId, originConfig]) => {
              switch (originConfig.type) {
                case "s3":
                  return {
                    originId,
                    domainName: bucket.bucketRegionalDomainName,
                    originAccessControlId: s3OriginAccessControl.id,

                    originPath: originConfig.originPath
                      ? `/${originConfig.originPath}`
                      : "",
                  };
                case "function": {
                  const functionEntry = functions[originId];

                  if (!functionEntry) {
                    throw new Error(
                      `No function found for function origin \`${originId}\``,
                    );
                  }

                  return {
                    originId,
                    domainName: functionEntry.functionUrl.functionUrl.apply(
                      (url) => new URL(url).host,
                    ),
                    originAccessControlId: lambdaOriginAccessControl.id,

                    customOriginConfig: {
                      httpPort: 80,
                      httpsPort: 443,
                      originProtocolPolicy: "https-only",
                      originReadTimeout: 20,
                      originSslProtocols: ["TLSv1.2"],
                    },
                  } as aws.types.input.cloudfront.DistributionOrigin;
                }
                default:
                  throw new Error(
                    `Unsupported origin type: \`${originConfig.type}\``,
                  );
              }
            },
          );
        },
      );
  }

  private buildBehaviors(props: {
    name: string;
    buildOutput: BuildOutput;
    basePath: pulumi.Input<string>;
    cfFunction: pulumi.Input<aws.cloudfront.Function>;
  }) {
    const serverBehaviorCachePolicy = new aws.cloudfront.CachePolicy(
      `${props.name}-cloudfront-cache_policy`,
      {
        defaultTtl: 0,
        maxTtl: 31536000, // 1 year
        minTtl: 0,
        parametersInCacheKeyAndForwardedToOrigin: {
          cookiesConfig: {
            cookieBehavior: "none",
          },
          headersConfig: {
            headerBehavior: "whitelist",
            headers: {
              items: ["x-open-next-cache-key"],
            },
          },
          queryStringsConfig: {
            queryStringBehavior: "all",
          },
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
        },
      },
      { parent: this },
    );
    return pulumi
      .all([props.buildOutput, props.basePath, props.cfFunction])
      .apply(([buildOutput, basePath, cfFunction]) => {
        return buildOutput.manifest.behaviors
          .sort(
            (left, right) => +(left.pattern === "*") - +(right.pattern === "*"),
          )
          .flatMap((behavior) => makeBehavior({ behavior }));

        function makeBehavior({
          behavior,
        }: {
          behavior: ArrayItem<OpenNextManifest["behaviors"]>;
        }): aws.types.input.cloudfront.DistributionOrderedCacheBehavior[] {
          const pathPatterns =
            behavior.pattern === "*" && basePath.substring(1)
              ? [
                  basePath.substring(1),
                  path.join(basePath.substring(1), behavior.pattern),
                ]
              : [behavior.pattern];

          if (behavior.origin === "s3") {
            return pathPatterns.map((pathPattern) => ({
              pathPattern,
              targetOriginId: behavior.origin,
              viewerProtocolPolicy: "redirect-to-https",
              allowedMethods: ["GET", "HEAD", "OPTIONS"],
              cachedMethods: ["GET", "HEAD"],
              compress: true,
              // CloudFront's managed CachingOptimized policy
              cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
            }));
          } else {
            return pathPatterns.map((pathPattern) => ({
              pathPattern,
              targetOriginId: behavior.origin,
              viewerProtocolPolicy: "redirect-to-https",
              allowedMethods: [
                "DELETE",
                "GET",
                "HEAD",
                "OPTIONS",
                "PATCH",
                "POST",
                "PUT",
              ],
              cachedMethods: ["GET", "HEAD"],
              compress: true,
              cachePolicyId: serverBehaviorCachePolicy.id,
              // CloudFront's Managed-AllViewerExceptHostHeader policy
              originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
              functionAssociations: [
                {
                  eventType: "viewer-request",
                  functionArn: cfFunction.arn,
                },
              ],
            }));
          }
        }
      });
  }
}

type ArrayItem<T> = T extends Array<infer U> ? U : never;
