# lab-workflows

This repository holds the shared pipeline of the pipeline lab.
A service repository does not copy the pipeline. It calls the workflows in this repository.

The pipeline has three reusable workflows and four composite actions.

| File | What it does |
| --- | --- |
| `.github/workflows/pr.yml` | Checks a pull request: lint, typecheck, tests, `cdk synth`. It has no AWS access. |
| `.github/workflows/release.yml` | Releases a push to `main`: version tag, one build, then Test (with the lock and the E2E gate), Staging and Production. |
| `.github/workflows/redeploy.yml` | Deploys an old release again. This is the rollback path. |
| `actions/next-version` | Works out the next version from the commit titles. |
| `actions/deploy` | Deploys one CDK stage from the cloud assembly of the build job. |
| `actions/lock-acquire` | Takes the lock of the shared Test environment. It waits when another release holds the lock. |
| `actions/lock-release` | Releases that lock. It never fails the release. |

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
3. `lock-test` takes the lock of the Test environment. It waits when another release holds the lock.
4. `deploy-test` deploys the stage `Test` in the GitHub environment `test`.
5. `e2e` runs the end-to-end suite of [lab-e2e](https://github.com/jross24/lab-e2e) against Test.
6. `unlock-test` releases the lock. It runs after a pass, after a failure and after a cancel.
7. `deploy-staging` deploys the stage `Staging` in the GitHub environment `staging`. It starts only if `e2e` passed. With `run-e2e: false` it starts after `deploy-test` passed.
8. `deploy-production` deploys the stage `Production` in the GitHub environment `production`.

`e2e-summary` runs when `e2e` ran. It writes the versions that the E2E run tested into the summary of the release. With `run-e2e: false` it does not run.

```
version -> build -> lock-test -> deploy-test -> e2e -> unlock-test
                                                  \-> deploy-staging -> deploy-production
```

Each deploy job starts only after the jobs before it passed. With `run-e2e: false`, `deploy-staging` accepts the skipped `e2e` job, but only after `deploy-test` passed.
If the `production` environment has a required reviewer, `deploy-production` waits until that person approves it.

### How the version is chosen

`actions/next-version` reads the commit titles since the last `v*` tag.

- A title with `!` before the colon, such as `feat!: ...`, gives a major version. The text `BREAKING CHANGE` in a commit message does the same.
- A title that starts with `feat:` or `feat(scope):` gives a minor version.
- All other titles give a patch version.
- The first release is `v0.1.0`.

If the commit already has a version tag, the action gives that version again. So you can run a failed release again.
The logic is a bash script. Run its tests with `bash actions/next-version/test.sh`.

### The time limit of each job

Each job that waits for something outside the runner has a `timeout-minutes` limit. A hung job then ends and frees the release queue.

| Job | Limit | Why |
| --- | --- | --- |
| `lock-test` | 25 minutes | The wait for the Test lock is 20 minutes at most. |
| `deploy-test` | 10 minutes | Part of the time budget of the lock (see "The time budget of the lock"). |
| `unlock-test` | 5 minutes | A short job. GitHub ends a cancelled job after 5 minutes. |
| `deploy-staging` | 15 minutes | Like Test, plus room. |
| `deploy-production` | 30 minutes | See below. |
| `redeploy` (in `redeploy.yml`) | 30 minutes | It can deploy to production. |

A service can release with CodeDeploy: the traffic of a Lambda alias moves to the new version in steps, and an alarm rolls it back.
CloudFormation waits for the CodeDeploy deployment, so the job `cdk deploy` waits too. A canary of "10 percent for 5 minutes" alone takes 5 minutes.
The limit of `deploy-production` is 30 minutes. It leaves room for the stack update, for the canary and for a rollback of the traffic and of the stack.
A job that waits for a required reviewer has not started, so that wait does not count against the limit.

The limit of `deploy-test` did not change. The stage Test and the stage Staging move the traffic all at once, which adds a short time.
The lock budget is therefore the same as before.

## The end-to-end gate

After `deploy-test`, the job `e2e` calls the workflow `run.yml` of [lab-e2e](https://github.com/jross24/lab-e2e) for the environment `test`.
The suite loads the page of web and calls the public APIs. It checks that the versions on the page equal the versions that the services report.
If the suite fails, `deploy-staging` does not start, so the release stops.

`e2e-summary` writes the exact versions that the suite tested into the summary of the release.
The summary of the E2E job itself also lists them, with the commit of lab-e2e.
When the suite fails, the called workflow may give no outputs to `e2e-summary`. The lab has not checked this, and the GitHub documentation does not say. In that case `e2e-summary` writes "not recorded". The summary of the E2E job still lists the versions.

### The input `run-e2e`

The input `run-e2e` of `release.yml` is a boolean. The default is `true`.
A caller sets it to `false` to skip the suite. Then `deploy-staging` accepts a skipped suite, but only after `deploy-test` passed.
A failed `deploy-test` also skips the suite, and that still stops the release.

```yaml
jobs:
  release:
    uses: jross24/lab-workflows/.github/workflows/release.yml@main
    with:
      run-e2e: false
    secrets: inherit
```

`run-e2e: false` does not skip the lock. The release still deploys to Test, so it still must wait for the other releases.

### How the nested call finds its environment, secrets and OIDC identity

A service repository calls `release.yml` of this repository. `release.yml` calls `run.yml` of lab-e2e.
So `run.yml` is a nested reusable workflow. The rules of the section "Secrets, variables and OIDC in a reusable workflow" apply to each level.

- The job `e2e` is a call, so it cannot set `environment:`. The job `suite` inside `run.yml` sets it. It is the `test` environment of the **service repository**, not of lab-e2e.
- `secrets.AWS_ACCOUNT_ID` is therefore the secret of the `test` environment of the service repository. `vars.AWS_REGION` is the variable of the service repository.
- `secrets: inherit` is needed at each level: in the service repository, and in the job `e2e` of this repository. GitHub passes secrets only to the workflow that a job calls directly. The documentation says: "Secrets are only passed to directly called workflow".
- The OIDC token names the service repository and the environment in its `sub` claim. It does not name lab-e2e. So the trust policy of `github-deploy` needs no change.
- The permissions can only stay the same or get lower along the chain. The job `e2e` asks for `id-token: write` and `contents: read`. The service repository gives `contents: write` and `id-token: write`, so this works.

These rules come from the GitHub documentation ([Reusing workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)).
The lab has proven the first level (a service repository calls `release.yml`) in a real run, as the section above shows.
The second level (`release.yml` calls `run.yml`) has not run in the lab yet. See "What is proven and what is not".

## The Test lock

### Why a lock is needed

All service repositories deploy to the same Test environment. Each release deploys to Test and then runs the E2E suite there.
Imagine that lab-web and lab-svc-catalogue release at the same time.
lab-web deploys. Then lab-svc-catalogue deploys over it. The suite of lab-web now tests a mix of versions that nobody planned.
If the suite fails, nobody can tell which change broke it.

So the releases must use Test one at a time. A release holds the lock from before `deploy-test` until after the E2E suite.
The lock covers the path of `release.yml` only. `redeploy.yml` can also deploy to Test, and it takes no lock. See "What the lock does not solve".

### Why a concurrency group does not work

The `concurrency` block in the caller makes the releases of **one repository** wait for each other.
It cannot protect Test, because Test has four repositories. The GitHub documentation says:

> When a concurrent job or workflow is queued, if another job or workflow using the same concurrency group in the repository is in progress, the queued job or workflow will be `pending`.

Source: [Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
The words "in the repository" are the limit. A group in lab-web and a group with the same name in lab-svc-catalogue are two different groups.
The documentation also says: "If you have multiple workflows in the same repository, concurrency group names must be unique across workflows".
The lab read the documentation and did not test this with two real repositories.

A lock in a place that all the repositories share solves this. The lab uses a DynamoDB table in the Test account.

### How the lock works

The table `lab-test-lock` has the partition key `lockId`. It has one item, with `lockId = "test-environment"`, while a release holds the lock.

| Attribute | Value |
| --- | --- |
| `holder` | `<repository>#<run id>#<run attempt>`, for example `jross24/lab-web#123#1` |
| `acquiredAt` | The start time, in epoch seconds |
| `expiresAt` | The end time, in epoch seconds. This is the start time plus 40 minutes. |

**Acquire** (`actions/lock-acquire`) writes the item with a conditional `PutItem`. The condition is:

```
attribute_not_exists(#id) OR #exp < :now OR begins_with(#holder, :run)
```

So the write works if the item does not exist, if the lock has expired, or if the same run holds it.
The code compares `expiresAt` with the clock itself. It does not wait for the TTL of DynamoDB to delete the item, because that deletion is slow. The TTL only cleans up.
`:run` is the holder without the attempt number (`jross24/lab-web#123#`). A re-run of a run has a new attempt number, and so it takes over the lock of its own earlier attempt.

If another run holds the lock, the action prints who holds it, a link to that run and the time that is left. It waits 15 seconds and tries again.
After 20 minutes of waiting it fails with a clear message.

**Release** (`actions/lock-release`) deletes the item with the condition `holder = <me>`.
If the item is gone, or another run holds it, the action prints a warning and succeeds. A cleanup step must not fail a release.

| Input | Default | Meaning |
| --- | --- | --- |
| `table` | `lab-test-lock` | The DynamoDB table. |
| `lock-id` | `test-environment` | The key of the item. |
| `timeout-minutes` (acquire) | `40` | The lock ends by itself after this time. |
| `max-wait-minutes` (acquire) | `20` | The longest wait for another release. |
| `poll-seconds` (acquire) | `15` | The time between two tries. |

#### The time budget of the lock

The lock must last longer than the longest release. If it ends too early, another release takes Test while this release still uses it.
The longest time that a release can hold Test is the sum of the limits of the jobs:

| Part | Limit |
| --- | --- |
| `deploy-test` (the `timeout-minutes` of the job in `release.yml`) | 10 minutes |
| The job `suite` of `run.yml` in lab-e2e (its `timeout-minutes`) | 12 minutes |
| The small jobs (`check` in `run.yml`) and the start of the runners | about 2 minutes |
| **Longest hold** | **24 minutes** |
| The lock (`timeout-minutes` of `lock-acquire`) | 40 minutes |
| **Margin** | **16 minutes** |

A normal release needs a few minutes. If you change one limit, calculate the sum again.
The wait of a release that queues is 20 minutes. A healthy holder can take up to 24 minutes in the worst case, so a waiting release can fail while the holder is still healthy. Then someone must start the release again.

The job that calls an action must log in to AWS first. The role `github-deploy` of the Test account can put, get and delete items in this table.
The code is the bash script `actions/lock/lock.sh`. Both actions call it. Run its tests with `bash actions/lock/test.sh`.

### What happens when something goes wrong

| Case | What happens |
| --- | --- |
| `deploy-test` fails | `e2e` is skipped. `unlock-test` still runs and releases the lock. `deploy-staging` does not start. |
| The E2E suite fails | `unlock-test` runs and releases the lock. `deploy-staging` does not start. |
| `lock-test` cannot get the lock in 20 minutes | The job fails. `deploy-test` does not run. `unlock-test` runs, finds that another run holds the lock, and warns. |
| Someone cancels the run | The expression `always()` "causes the step to always execute, and returns true, even when canceled". `unlock-test` has the condition `always() && needs.lock-test.result != 'skipped'`, so it still runs after a cancel, if the job `lock-test` ran. The cancel reference says that GitHub ends all jobs that still run 5 minutes after the cancel, so the job must be short. It is short. That page describes jobs that already run. It does not describe a job that still waits for its `needs`. The lab has not tested this case. |
| A runner dies, or GitHub force-cancels the run | `unlock-test` may not run. The lock ends by itself after 40 minutes. This is the safety valve. |
| `deploy-test` hangs | The job limit is 10 minutes, less than the 40 minutes of the lock. So the job ends before the lock expires. |
| The lock expires while a release still uses Test | Another release can take the lock. Both then use Test. The time budget above (24 minutes at most for 40 minutes of lock) makes this unlikely. |
| A person starts "Re-run failed jobs" after a failed `deploy-test` or a failed E2E suite | The re-run uses Test without the lock. See the limits below. |

Cancel and force-cancel are from the documentation. The lab has not tested them.

### What the lock does not solve

**The set of versions that passed in Test can differ from the set in Staging and Production.**
The E2E suite tests the versions that are in Test at that time, for example web 0.2.0 with catalogue 0.1.0.
Each service repository promotes by itself. Staging may hold catalogue 0.1.1 when web 0.2.0 arrives there. Production may hold yet another set.
So "the suite passed in Test" does not mean "this set of versions works in Staging or in Production".
The lock only makes the result in Test attributable. It does not pin the set.
To close this gap, a team must promote a whole set of versions, or use contract tests that check each pair of services on its own. See [lab-platform#21](https://github.com/jross24/lab-platform/issues/21).

Other limits:

- **The lock is not a queue.** Waiting releases poll. The release that polls first after the lock ends wins. There is no order and no fairness.
- **The clock of the runner decides.** The expiry compares the clocks of different runners. GitHub synchronises them, and the margin is 16 minutes, so a few seconds of drift do not matter.
- **A release that runs again with "Re-run failed jobs" does not take the lock again.** This holds after a failed `deploy-test` and after a failed E2E suite. The job `lock-test` passed, so GitHub does not run it again. `unlock-test` released the lock in the first attempt. The re-run of `deploy-test` or of `e2e` then changes or uses Test without the lock. See [lab-platform#19](https://github.com/jross24/lab-platform/issues/19).
- **A redeploy to Test takes no lock.** `redeploy.yml` can deploy to `test`, for a rollback. It can change Test while a release holds the lock, and then the E2E suite of that release tests a different version. See [lab-platform#24](https://github.com/jross24/lab-platform/issues/24).
- **A run that lab-e2e starts itself** (a push to its `main`, the nightly schedule or a manual run) does not take the lock. A release that deploys to Test at the same time can disturb it. See [lab-platform#19](https://github.com/jross24/lab-platform/issues/19).
- **The lock covers Test only.** Staging and Production have no lock table.

### The trade-off

A lock makes the releases queue. This has a cost:

- One slow or stuck release delays every team. The wait is up to 20 minutes, and then the next release fails and someone must start it again.
- The expiry is the safety valve. It frees a lock that a dead run holds. The price is a wait of up to 40 minutes after a crash. A release that waits for 20 minutes fails before that, and someone must start it again.
- Every release now needs the lock table, SSM and the E2E repository. More parts can fail.

The alternative is a Test environment for each team or for each change. That costs more, but it needs no queue.

## What is proven and what is not

| Claim | State |
| --- | --- |
| The pure functions of the lock (holder text, expiry, argument checks) | Tested by `actions/lock/test.sh`. CI runs it. |
| The acquire and release logic: waiting, expiry, take-over, re-run, errors | Tested by `actions/lock/test.sh` against a fake `aws` command and a fake clock. The tests do not call AWS. |
| The condition expression against the real DynamoDB table | **Not tested.** The tests check the text of the condition, and the fake applies the same rule. |
| The lock between two real releases | **Not tested.** See the steps below. |
| `unlock-test` after a failed E2E suite, a failed deploy and a cancel | **Not tested** in Actions. |
| The nested call `release.yml` -> `run.yml` (environment, secrets, OIDC identity) | **Not tested.** It follows the documentation. |
| The outputs of the E2E job reach `e2e-summary` when the suite fails | **Not verified.** The documentation does not say. `e2e-summary` writes "not recorded" for an empty output. |
| A concurrency group is limited to one repository | From the documentation. Not tested. |

### How to prove it in Actions

[lab-platform#20](https://github.com/jross24/lab-platform/issues/20) tracks this work. Do it after the permission for SSM (lab-platform) is deployed in all three accounts, and after the release queue is free.
The queue is free when the four waiting releases at `deploy-production` have an answer, and no release is running.

1. Run the E2E workflow alone. It proves the login, the SSM read and the suite.

   ```
   gh workflow run run.yml --repo jross24/lab-e2e -f environment=test
   gh run watch --repo jross24/lab-e2e
   ```

2. Open two small pull requests in two service repositories, for example a change to a README in lab-svc-catalogue and in lab-svc-account. Merge both in the same minute:

   ```
   gh pr merge <number> --repo jross24/lab-svc-catalogue --squash --delete-branch
   gh pr merge <number> --repo jross24/lab-svc-account --squash --delete-branch
   ```

3. Watch the two runs. One `lock-test` job must say `The lock of test-environment is yours`. The other must print `is held by`, a link to the first run and the time that is left, then wait.

   ```
   gh run list --repo jross24/lab-svc-catalogue --workflow release --limit 1
   gh run list --repo jross24/lab-svc-account --workflow release --limit 1
   gh run view <run id> --repo <repository> --log | grep -E "lock|Waiting"
   ```

4. Read the lock while the first release runs (this is a read-only call):

   ```
   aws dynamodb get-item --table-name lab-test-lock --key '{"lockId":{"S":"test-environment"}}' --consistent-read --profile lab-test
   ```

5. The second `deploy-test` must start only after the first `unlock-test` finished. Compare the start and end times of the jobs:

   ```
   gh run view <run id> --repo <repository> --json jobs --jq '.jobs[] | [.name, .startedAt, .completedAt] | @tsv'
   ```

6. When both releases are done, `get-item` must return no item.

7. The check of a failed suite: merge a change to lab-e2e that makes one test fail on purpose (for example, a test that expects the version `9.9.9` of web). Then release one service. `e2e` must fail, `unlock-test` must succeed, `deploy-staging` must be skipped, and `get-item` must return no item. Then revert the change in lab-e2e. This stops the gate for all teams while it is in place, so do it when nobody releases.

8. The check of a cancel: start a release, cancel it while `e2e` runs, and check that `unlock-test` ran and `get-item` returns no item. If `unlock-test` did not run, the item must be gone 40 minutes after `acquiredAt`.

## The redeploy workflow

`redeploy.yml` has two inputs: `version` and `environment`.
It downloads the zip of that version from the GitHub release. It checks the zip against the SHA-256 file of the release.
Then it deploys the zip to that environment. It does not build.

Use it to go back to an old version. The old version is the old artefact, not a new build of old code.
For a service that releases in steps, a redeploy moves the traffic in steps too. A redeploy to `production` takes more than 5 minutes.
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
    # with:
    #   run-e2e: false   # see "The input run-e2e"
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

The job `e2e` adds a second level: `release.yml` calls `run.yml` of lab-e2e. The section "The end-to-end gate" explains how the environment, the secrets and the OIDC identity work there.

## Two releases at the same time

The `concurrency` block in the caller makes a second release wait for the first one.
`cancel-in-progress: false` means that GitHub never stops a deployment that is in progress.

This block works for the releases of one repository only. The Test lock (above) makes the releases of different repositories wait for each other.

Know these two limits:

- A release that waits for the production reviewer is still in progress. The next release waits behind it until someone approves or rejects it.
- By default, GitHub keeps only one waiting run in a group. If a third release arrives, GitHub cancels the second one. The third release contains the commits of the second one, so no change is lost. The documentation also describes `queue: max`. It lets up to 100 runs wait. The lab does not use it.

The release with the lock waits at `lock-test`, before it deploys. A release that waits for the lock is in progress, so the next release of the same repository waits behind it.

## Why the references use `@main`

The service repositories call `...@main`, and the workflows in this repository call the composite actions with `@main`.
So a change in this repository changes the pipeline of each service at its next run.

A real team pins a version tag or a commit SHA, for example `release.yml@v1`.
Then a change to the pipeline reaches a service only when that service moves the pin. A bad change cannot break all the services at one time. A pinned SHA also protects against a changed tag.

This lab accepts `@main` for two reasons. One person owns all the repositories. The lab wants a pipeline change to show its effect immediately.

Actions from other owners are different. This repository pins each of them to a full commit SHA.

## Checks of this repository

The `ci` workflow runs on each pull request. It runs the tests of the next-version script and the tests of the lock script.
It also runs `shellcheck` and `actionlint`, but only if the runner image already has them. The repository installs no tool.
The runner image has `shellcheck`. It does not have `actionlint`, so the CI skips it and no tool checks the workflow files. See [lab-platform#22](https://github.com/jross24/lab-platform/issues/22).
