# Pulumi NextJS Starter

This repository is an exercise in deploying multiple Next.JS apps to a single
CloudFront distribution using OpenNext.

Pulumi has an example in [pulumi/examples](https://github.com/pulumi/examples/tree/master/aws-ts-nextjs),
but it is more or less a bare minimum implementation that has a number of
hard-coded configuration items which wouldn't scale well into a monorepo.

As a result, I referenced code from [sst/ion](https://github.com/sst/ion/blob/dev/platform/src/components/aws/nextjs.ts)
in an effort to provide a more complete re-usable implementation.

Example environment files are included to showcase setting up the Pulumi
backend and specifying proper use of AWS profiles.

## Outstanding TODOs
- Design guards to isolate environments to some degree (dev vs prod)
- Add Turborepo generators for new UI elements and additional web apps
- Add the ability to define a CNAME for the CloudFront distribution.
- Allow passing environment variables and attaching extra IAM policies to the server functions
- Fill out demo sites more to validate usage of the above
- Add policies to the server function URLs to restrict access to only the
  CloudFront distribution.
- Add the warmer function (not high priority since I won't be using that any time soon)
- Add edge function support (same as above)
