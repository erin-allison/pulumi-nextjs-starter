export type BaseFunction = {
  handler: string;
  bundle: string;
};

export type OpenNextFunctionOrigin = {
  type: "function";
  streaming?: boolean;
} & BaseFunction;

export type OpenNextECSOrigin = {
  type: "ecs";
  bundle: string;
  dockerfile: string;
};

export type OpenNextS3Origin = {
  type: "s3";
  originPath: string;
  copy: {
    from: string;
    to: string;
    cached: boolean;
    versionedSubDir?: string;
  }[];
};

export type OpenNextOrigins =
  | OpenNextFunctionOrigin
  | OpenNextECSOrigin
  | OpenNextS3Origin;

export interface OpenNextManifest {
  edgeFunctions: {
    [key: string]: BaseFunction;
  };
  origins: {
    s3: OpenNextS3Origin;
    default: OpenNextFunctionOrigin | OpenNextECSOrigin;
    imageOptimizer: OpenNextFunctionOrigin | OpenNextECSOrigin;
    [key: string]: OpenNextOrigins;
  };
  behaviors: {
    pattern: string;
    origin: string;

    // This was the original type, but since we don't support edge functions...
    // pattern: string;
    // origin?: string;
    // edgeFunction?: string;
  }[];
  additionalProps?: {
    disableIncrementalCache?: boolean;
    disableTagCache?: boolean;
    initializationFunction?: BaseFunction;
    warmer?: BaseFunction;
    revalidationFunction?: BaseFunction;
  };
}
