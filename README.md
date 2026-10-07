# lab-workflows

This repository holds the shared pipeline of the pipeline lab.
A service repository does not copy the pipeline. It calls the workflows in this repository.

The pipeline has three reusable workflows and two composite actions.

| File | What it does |
| --- | --- |
| `.github/workflows/pr.yml` | Checks a pull request: lint, typecheck, tests, `cdk synth`. It has no AWS access. |
| `.github/workflows/release.yml` | Releases a push to `main`: version tag, one build, then Test, Staging and Production. |
| `.github/workflows/redeploy.yml` | Deploys an old release again. This is the rollback path. |
| `actions/next-version` | Works out the next version from the commit titles. |
| `actions/deploy` | Deploys one CDK stage from the cloud assembly of the build job. |

## Build once, promote the same artefact

`cdk synth` turns the CDK code into a directory named `cdk.out`. AWS calls this directory a cloud assembly.
It holds the CloudFormation templates and the bundled Lambda code of all the stages.

The `build` job is the only job that runs `cdk synth`. It runs it one time.
Then it zips `cdk.out` and calculates the SHA-256 of the zip.
The three deploy jobs download that zip. They do not run `cdk synth` and they do not bundle code.

This matters because a second build is a second chance for a difference.
A dependency can publish a new version between two builds. A build tool can give a different result on a different day.
If each environment has its own build, a test in Staging does not prove much about Production.
With one build, the bytes that passed in Test are the bytes that go to Staging and to Production.

The pipeline proves this in three ways:

1. Each deploy job calculates the SHA-256 of the zip that it downloaded. If it is not the SHA-256 from the `build` job, the job fails before it deploys.
2. Each deploy job runs `cdk deploy --app cdk.out "<Stage>/*"`. The `--app cdk.out` option tells the CDK to read the directory and not to run the app.
3. After the deployment, the job reads the `Version` output of the stack. If it is not the version of the release, the job fails. The job writes the version and the SHA-256 to the job summary.

You can also compare the result in AWS. The `CodeSha256` of the Lambda function is the same in each account.

## The release workflow

`release.yml` runs these jobs in this order:

1. `version` works out the next version and creates the tag on the released commit.
2. `build` runs `npm ci`, lint, typecheck, the tests and one `cdk synth -c version=<version>`. It uploads the zip as a workflow artefact. It also attaches the zip to a GitHub release with the name of the tag.
3. `deploy-test` deploys the stage `Test` in the GitHub environment `test`.
4. `deploy-staging` deploys the stage `Staging` in the GitHub environment `staging`.
5. `deploy-production` deploys the stage `Production` in the GitHub environment `production`.

Each deploy job starts only after the job before it passed.
If the `production` environment has a required reviewer, `deploy-production` waits until that person approves it.

### How the version is chosen

`actions/next-version` reads the commit titles since the last `v*` tag.

- A title with `!` before the colon, such as `feat!: ...`, gives a major version. The text `BREAKING CHANGE` in a commit message does the same.
- A title that starts with `feat:` or `feat(scope):` gives a minor version.
- All other titles give a patch version.
- The first release is `v0.1.0`.

If the commit already has a version tag, the action gives that version again. So you can run a failed release again.
The logic is a bash script. Run its tests with `bash actions/next-version/test.sh`.

## The redeploy workflow

`redeploy.yml` has two inputs: `version` and `environment`.
It downloads the zip of that version from the GitHub release. It checks the zip against the SHA-256 file of the release.
Then it deploys the zip to that environment. It does not build.

Use it to go back to an old version. The old version is the old artefact, not a new build of old code.
The rules of the GitHub environment apply to a redeploy too. A redeploy to `production` waits for the reviewer.

## Use the pipeline in a service repository

Add three small workflow files to the service repository.

```yaml
# .github/workflows/pr.yml
name: pr
on:
  pull_request:
permissions:
  contents: read
jobs:
  pr:
    uses: jross24/lab-workflows/.github/workflows/pr.yml@main
```

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    branches: [main]
concurrency:
  group: release
  cancel-in-progress: false
permissions:
  contents: write
  id-token: write
jobs:
  release:
    uses: jross24/lab-workflows/.github/workflows/release.yml@main
    secrets: inherit
```

```yaml
# .github/workflows/redeploy.yml
name: redeploy
on:
  workflow_dispatch:
    inputs:
      version:
        description: The version to deploy, for example 1.2.3
        required: true
        type: string
      environment:
        description: The environment to deploy to
        required: true
        type: choice
        options: [test, staging, production]
permissions:
  contents: read
  id-token: write
jobs:
  redeploy:
    uses: jross24/lab-workflows/.github/workflows/redeploy.yml@main
    with:
      version: ${{ inputs.version }}
      environment: ${{ inputs.environment }}
    secrets: inherit
```

The service repository must have these things:

- The npm scripts `lint`, `typecheck` and `test`, and a committed `package-lock.json`.
- A CDK app that makes the stages `Test`, `Staging` and `Production` in one `cdk synth`. The stacks have no account and no region in the code.
- A context value `version`. The app puts it in a stack output named `Version`.
- The GitHub environments `test`, `staging` and `production`. Each one has a secret `AWS_ACCOUNT_ID`.
- A repository variable `AWS_REGION`.
- A name that starts with `lab-`. The trust policy of the `github-deploy` role accepts only those repositories.

## Secrets, variables and OIDC in a reusable workflow

The account ID of each environment is an environment secret of the service repository.
The deploy jobs are in this repository. These rules make the secret reach them.

- A reusable workflow reads the secrets and variables of the **caller** repository. It does not read the secrets of this repository.
- The job in the reusable workflow sets `environment:`. A caller job that has `uses:` cannot set `environment:`.
- The caller must also pass its secrets. The service repositories use `secrets: inherit`. The GitHub documentation says that the secret is an empty string if the caller does not pass it.
- With both in place, `secrets.AWS_ACCOUNT_ID` in the job is the secret of that job's environment. So one name gives three different accounts in three jobs.
- The `vars` context needs nothing. The reusable workflow reads `vars.AWS_REGION` of the caller repository directly.
- The caller gives the permissions. A reusable workflow can lower them but cannot raise them. So the caller must give `id-token: write`, or the job cannot ask GitHub for an OIDC token.
- The OIDC token names the caller repository and the environment of the job in its `sub` claim. It does not name this repository there. So the trust policy of `github-deploy` works with no change.
- The protection rules of the environment also apply. A job in `production` waits for the required reviewer, even though the job is defined in this repository.

`secrets: inherit` gives the called workflow all the secrets of the caller. That is acceptable here, because the same owner controls both repositories.

### What a real run showed

The first release of `lab-svc-core` (`v0.1.0`) tested these rules.

- The caller had `secrets: inherit` and no repository secret named `AWS_ACCOUNT_ID`. The jobs `deploy-test` and `deploy-staging` each set `environment:` and each logged in to a different account. So the job got the secret of its own environment.
- `vars.AWS_REGION` was the repository variable of the caller. The caller passed nothing for it.
- The `github-deploy` role accepted the OIDC token of a job that is defined in this repository. Its trust policy allows only `lab-*` repositories in the matching environment. So the `sub` claim named the caller repository and the environment.
- `deploy-production` stopped in the state `waiting` for the required reviewer of the caller repository.
- The log showed the account ID as `***`, also in the stack ARN that `cdk deploy` prints.
- The Lambda function had the same `CodeSha256` in the Test account and in the Staging account.

One rule comes only from the GitHub documentation: the secret is an empty string if the caller does not pass it. The lab did not test a caller with no `secrets: inherit`.

## Two releases at the same time

The `concurrency` block in the caller makes a second release wait for the first one.
`cancel-in-progress: false` means that GitHub never stops a deployment that is in progress.

Know these two limits:

- A release that waits for the production reviewer is still in progress. The next release waits behind it until someone approves or rejects it.
- GitHub keeps only one waiting run in a group. If a third release arrives, GitHub cancels the second one. The third release contains the commits of the second one, so no change is lost.

## Why the references use `@main`

The service repositories call `...@main`, and the workflows in this repository call the composite actions with `@main`.
So a change in this repository changes the pipeline of each service at its next run.

A real team pins a version tag or a commit SHA, for example `release.yml@v1`.
Then a change to the pipeline reaches a service only when that service moves the pin. A bad change cannot break all the services at one time. A pinned SHA also protects against a changed tag.

This lab accepts `@main` for two reasons. One person owns all the repositories. The lab wants a pipeline change to show its effect immediately.

Actions from other owners are different. This repository pins each of them to a full commit SHA.

## Checks of this repository

The `ci` workflow runs on each pull request. It runs the tests of the next-version script.
It also runs `shellcheck` and `actionlint`, but only if the runner image already has them. The repository installs no tool.
