# lab-workflows

This repository holds the shared pipeline of the pipeline lab.
A service repository does not copy the pipeline. It calls the workflows in this repository.

The pipeline has three reusable workflows and several composite actions.

| File | What it does |
| --- | --- |
| `.github/workflows/pr.yml` | Checks a pull request: lint, typecheck, tests, `cdk synth`, a dependency check, a secret scan and `actionlint`. It has no AWS access. |
| `.github/workflows/release.yml` | Releases a push to `main`: version tag, one build, then Test (with the lock and the E2E gate), Staging and Production. |
| `.github/workflows/redeploy.yml` | Deploys an old release again. This is the rollback path. |
| `actions/next-version` | Works out the next version from the commit titles. |
| `actions/deploy` | Deploys one CDK stage from the cloud assembly of the build job. |
| `actions/lock-acquire` | Takes the lock of the shared Test environment. It waits when another release holds the lock. |
| `actions/lock-release` | Releases that lock. It never fails the release. |
| `actions/install-tool` | Installs a tool from a pin: a version, a url and a SHA-256. It checks the download before it uses it. |
| `actions/changed-paths` | Tells whether a pull request changes a file under some paths, for example `.github/`. |
| `.github/workflows/diff.yml` | Shows the `cdk diff` against Production as one comment on a pull request, and blocks a delete of a stateful resource. See "The cdk diff comment". |
| `actions/cdk-diff` | The scripts and the tests behind `diff.yml`. |
| `actions/secret-scan` | Scans the commits of a pull request for secrets with `gitleaks`. It never prints a secret. |

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
| `deploy-test` | 15 minutes | Part of the time budget of the lock (see "The time budget of the lock"). It is 15 and not 10 because the first deployment of CloudWatch Transaction Search in an account waits about 6 minutes for the setting. |
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
| `on-timeout` (acquire) | `fail` | What the action does when the wait is over. `fail` fails the step. `skip` prints a notice, sets `acquired` to `false` and succeeds. |
| `fail-hint` (acquire) | empty | A sentence that the error message adds. It tells the reader what to do. |

`lock-acquire` has three outputs.

| Output | Meaning |
| --- | --- |
| `holder` | The holder text that this run wrote. Empty if the action did not take the lock. |
| `acquired` | `true` if this run holds the lock. `false` if `on-timeout` is `skip` and the lock stayed with another run. |
| `fresh` | `false` if this run held the lock before the call. The call then only starts the expiry again. `true` if the lock was free, had expired, or came from an earlier attempt of this run. |

A wait of 0 minutes (`max-wait-minutes: 0`) makes one try and does not wait.
A job uses it to check that its run holds the lock, without a long wait.

#### The time budget of the lock

The lock must last longer than the longest release. If it ends too early, another release takes Test while this release still uses it.
The longest time that a release can hold Test is the sum of the limits of the jobs:

| Part | Limit |
| --- | --- |
| `deploy-test` (the `timeout-minutes` of the job in `release.yml`) | 15 minutes |
| The job `suite` of `run.yml` in lab-e2e (its `timeout-minutes`) | 12 minutes |
| The small jobs (`check` in `run.yml`) and the start of the runners | about 2 minutes |
| **Longest hold** | **29 minutes** |
| The lock (`timeout-minutes` of `lock-acquire`) | 40 minutes |
| **Margin** | **11 minutes** |

A normal release needs a few minutes. If you change one limit, calculate the sum again.
The wait of a release that queues is 20 minutes. A healthy holder can take up to 29 minutes in the worst case, so a waiting release can fail while the holder is still healthy. Then someone must start the release again.

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
| `deploy-test` hangs | The job limit is 15 minutes, less than the 40 minutes of the lock. So the job ends before the lock expires. |
| The lock expires while a release still uses Test | Another release can take the lock. Both then use Test. The time budget above (29 minutes at most for 40 minutes of lock) makes this unlikely. |
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
- **The clock of the runner decides.** The expiry compares the clocks of different runners. GitHub synchronises them, and the margin is 11 minutes, so a few seconds of drift do not matter.
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

## The cdk diff comment

Every pull request of a service repository can show what a release would change in Production.
The reusable workflow `diff.yml` posts the answer as one comment. The comment changes in place on each push, so the pull request never gets a second one.

The comment has one line with the counts, for example `1 to add, 2 to change, 0 to replace, 1 to delete`. The full diff is in a folded block below it.

### The four jobs

A pull request runs code that its author wrote. The workflow keeps that code away from every credential. Four jobs do the work:

| Job | What it holds | What it runs |
| --- | --- | --- |
| `gate` | Nothing | A script of this repository. It decides if the diff can run. |
| `fetch` | The AWS role `github-pr-diff` (an OIDC token) | The code of `diff.yml` only. It reads the deployed template and the version of each stack. |
| `compute` | Nothing (no AWS credentials, no write token) | The code of the pull request: `npm ci` and `cdk synth`. Then `cdk diff --template`, which needs no AWS access. |
| `report` | The right to write a comment | A script of this repository. It reads the diff as data. It runs no code of the pull request. |

The jobs pass plain files to each other as workflow artefacts. An artefact of a public repository is public, so `fetch` removes account numbers from the templates before it uploads them.

The role `github-pr-diff` has two read actions on the stacks with a name that starts with `lab-`. Its trust policy checks the `sub` claim and the `job_workflow_ref` claim.
So only the file `diff.yml` on `main` of this repository can use the role. The README of [lab-platform](https://github.com/jross24/lab-platform) shows the test and the security model.

### The version number is not a change

The synth of a pull request uses the version `0.0.0-dev` by default. A release uses a new version. So the version would show as a change on every pull request.
The job `fetch` reads the output `Version` of the deployed stack. The job `compute` synthesises with `-c version=<that version>`.
The comment says which version it used. Set the input `pass-version` to `false` for an app that has no `version` context value.

### The stateful change guard

A delete or a replacement of a resource that holds data can lose that data. The check fails when the diff contains such a change, unless the pull request has the label `destructive-change-approved`.

The list of types is short on purpose. It is `STATEFUL_TYPES` in `actions/cdk-diff/lib.mjs`:
`AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable`, `AWS::S3::Bucket`, `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::EFS::FileSystem`, `AWS::Cognito::UserPool`, `AWS::KMS::Key` and `AWS::Logs::LogGroup`.
A log group is in the list because a deleted log group deletes the history of the service. Add a type to the list when the lab starts to use it.

The guard uses two sources and joins them:

- The text of `cdk diff` shows a replacement. For example, `[~] AWS::DynamoDB::Table Orders Orders replace`. A change of the key schema of a table gives this line.
- The templates show a delete. A resource of the deployed template that the new template does not have is deleted. With `DeletionPolicy: Retain` CloudFormation only stops to manage it. The guard calls that case an `orphan` and blocks it too.
  A new logical ID is a delete and a create. CDK gives a new logical ID when someone changes the ID of a construct. This is the usual way to lose a table by accident.

The second source does not depend on the text format of the CLI. If a new CLI changes its text, a delete is still found.

When the check fails, the comment names the resource and the way out: add the label, then re-run the failed job.
The job reads the labels of the pull request at the time it runs, so a re-run sees the new label. The caller does not listen to label events. A label event would start the whole `pr` workflow again.
The label has an exact spelling. A person with triage rights can add it, and it stays visible on the pull request.

### A pull request from a fork

GitHub gives the jobs of a fork pull request no secret and no `id-token`. The job `gate` sees that the head repository is not this repository.
It skips the other jobs and writes a notice with the reason in the log and in the job summary. The check does not fail.
A Dependabot pull request is skipped for the same reason. So is a repository that has no account secret.
`gate` runs `decideRun` in `actions/cdk-diff/lib.mjs`. Unit tests cover the fork, the Dependabot, the missing secret and the other events.

The live fork case is not proven. The owner of the lab has one GitHub account, and a user cannot fork his own repository.

### No account number in the comment

A comment is not masked like a log. The workflow removes account numbers in two layers, before it posts and before it writes the job summary:

1. It replaces the account IDs that the job knows (the secret) wherever they appear, even inside a word.
2. It replaces any other run of 12 digits that has no letter or digit next to it. This catches the account field of an ARN, the name of a role and the name of a bucket.

Both layers run on the whole comment. Unit tests check an ARN, a role name, a bucket name and numbers that are not account IDs, such as a hash or a timestamp.
The log is masked too: `configure-aws-credentials` runs with `mask-aws-account-id: true`.

### What the pull request needs

| Item | Why |
| --- | --- |
| The caller grants `contents: read`, `id-token: write` and `pull-requests: write`. | A reusable workflow cannot get more permission than the caller gives. |
| The caller passes `secrets: inherit`. | The jobs need the account secret. |
| A repository secret `PR_ACCOUNT_ID_PRODUCTION` that holds the ID of the Production account. | A pull request job names no GitHub environment, so it cannot read an environment secret. A repository secret is not available to a fork. |
| A repository variable `AWS_REGION`. | The region of the role. |
| The label `destructive-change-approved` exists in the repository. | A person must be able to add it. |
| The stack has the same name as the repository, or the caller sets `stack-names`. | The workflow reads the stack by its name. |

The inputs of `diff.yml` are `stage` (default `Production`), `account-secret`, `stack-names`, `synth-args`, `title`, `key`, `pass-version` and `tools-ref`.
Each `key` has its own comment on the pull request. The platform repository uses one key for each account.

### Test a change of this workflow before it reaches `main`

The role trusts `diff.yml` on `main` only. To test a branch, use the `dev` account:

1. Deploy the `Platform` stack of lab-platform to `dev` with `-c 'workflowRef=refs/heads/feat/*'`. The README of lab-platform shows the command.
2. Open a draft pull request in a service repository. Let it call `diff.yml@<your branch>` with `account-secret: PR_ACCOUNT_ID_DEV` and `tools-ref: <your branch>`.
3. Close the pull request without a merge. Deploy `dev` again without `workflowRef`.

### Facts that differ from what you may expect

- `cdk diff` exits with `0` when it finds differences, although its help text says it returns status 1. Use `--fail` if you want a non-zero exit code.
- The default `--method auto` of `cdk diff` creates a change set and uses the deploy role. That is a write call. `--method template` uses the lookup role. `--template <file>` needs no AWS call.
- The lookup role has the managed policy `ReadOnlyAccess`, so it can read S3 objects and DynamoDB items. The diff does not use it.
- The context value `github.job_workflow_sha` is empty in a reusable workflow, although the documentation lists it. The OIDC claim `job_workflow_sha` has the value.

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

## The scans in the pull request workflow

`pr.yml` has three jobs next to `check`: `dependencies`, `secrets` and `actionlint`. In a service repository the checks are named `pr / dependencies`, `pr / secrets` and `pr / actionlint`.
Each job asks only for `contents: read`. So the caller needs no change.
The jobs use the actions of this repository with `@main`, like the release workflow.

### The dependency check

The job `dependencies` runs `actions/dependency-review-action` (v5.0.0, pinned to a full commit SHA). GitHub owns this action.
It compares the dependency graph of the base commit with the graph of the head commit. It fails when the pull request adds or changes a package that has an advisory of severity `high` or `critical`.
It checks the scopes `runtime` and `development`, because a build tool also runs in CI. It does not check licences.

**Why this and not `npm audit` with a baseline.** `npm audit` reports a `brace-expansion` copy inside `aws-cdk-lib` ([lab-platform#15](https://github.com/jross24/lab-platform/issues/15)).
Nobody can fix it, because `aws-cdk-lib` ships that copy inside its own package. A plain `npm audit` stays red for ever.
A baseline can hide that one finding, but a person must keep the baseline up to date in each repository.

The diff tool needs no baseline. The old finding is in the base commit and in the head commit, so it is not in the diff. A new package with an advisory is in the diff, so the job fails.
The lab tested both cases. A change to the `aws-cdk-lib` entry of the lockfile passed. A new dependency on `minimist` 1.2.5 (critical advisory GHSA-xvch-5gv4-984h) failed.

**What the diff tool misses.** It misses a new advisory against a package that no pull request changes. The lockfile does not change, so there is no diff.
`npm audit` finds this case, because it audits the whole tree each time. But then every pull request turns red on the day of the advisory, also a pull request that does not touch a dependency.
The lab covers the gap with Dependabot alerts, which are native and free. They notify the owner. They do not block a pull request.

**Why `high`.** A check that people ignore protects nobody. A lower level fails more pull requests, and the owner of the lab would soon learn to ignore it.
`high` and `critical` are the findings that need action now. Change `fail-on-severity` in `pr.yml` to change the level.

**The dependency graph must be on.** The action reads the dependency graph of the repository. On the lab repositories the graph was off.
Then the job fails with the message "Dependency review is not supported on this repository".
The REST API turns the graph on only together with Dependabot alerts (`PUT /repos/{owner}/{repo}/vulnerability-alerts`). It turns the graph off again when you turn the alerts off.
So the four service repositories have Dependabot alerts on. A new service repository needs the same setting.

### The secret scan

The lab uses two layers, because each layer has a gap that the other one closes.

**Layer 1: native secret scanning and push protection.** Both are on in all seven repositories. They are free for a public repository.
Push protection refuses a push that holds a known provider token, before the token reaches the repository. In a test it refused a fake Slack token and a fake Stripe key (error `GH013`, "Push cannot contain secrets").
It has four limits. It knows only the patterns of providers. A person can bypass it with a click and a reason. It gives no failing check on the pull request.
And it let a fake GitHub token through in the test. The lab did not find out why.

**Layer 2: the job `secrets`.** It runs `gitleaks` on the commits of the pull request. It runs after the push, so in a public repository the secret is already public when the job fails.
But the job is a check that a person cannot bypass with a click. It also finds generic patterns, for example `api_key = "<random text>"`, and tokens that push protection let through.
In the test it found the fake GitHub token that push protection did not block.

The job has these properties:

- It scans only the commits after the base commit, up to the head commit. Older history is not scanned.
- It scans merge commits too. A secret that an author adds while the author resolves a merge conflict is found.
- It never prints a secret. `gitleaks` redacts the value, and the report holds only the rule, the file, the line and the short commit id. It holds no author and no email address.
- A pull request cannot weaken it. The rules come from `actions/secret-scan/gitleaks.toml`. A config file or a `.gitleaksignore` file in the scanned repository has no effect, and a `gitleaks:allow` comment has no effect.
  To allow a false positive, add an allow rule to `gitleaks.toml` in a pull request to this repository.

If the job fails, treat the secret as public. Revoke or rotate it first. Then remove it from the commits. Deleting the branch does not hide the commit in a public repository.

**Two native options that did not turn on.** The lab tried the settings `secret_scanning_non_provider_patterns` and `secret_scanning_validity_checks` on all seven repositories.
The REST API answers `200 OK`, but the value stays `disabled`. The documentation does not say whether a free public repository can use them.

### The actionlint job

The job `actionlint` checks the workflow files of the service repository. It runs only when the pull request changes a file under `.github/`.
The action `actions/changed-paths` decides this with `git diff --name-only base...head`. The three dots compare the head with the merge base, so a change that only the base branch has does not count.

If nothing under `.github/` changed, the job passes and prints the notice "actionlint is skipped". The job always finishes, so a required check never waits for ever.
If the action cannot tell what changed, it runs the check. A check that runs without need is better than a check that is skipped without reason.
`actionlint` checks all workflow files of the repository, not only the changed ones. It also runs `shellcheck` on the `run:` scripts, because the runner image has `shellcheck`.

### Test a change of `pr.yml` before it reaches `main`

The jobs use the actions with `@main`. So an action must be on `main` before a test can use it. Merge a change of an action first, and change `pr.yml` in a second pull request.

To test `pr.yml`, create a branch in a service repository, for example `test-base`. Change its `pr.yml` to call `pr.yml@<your branch>`.
Then open draft pull requests against `test-base`, not against `main`. Their diff holds only the test change, and each pull request runs the workflow of your branch.
Close the pull requests without a merge and delete the branches.

## Install a tool with a pinned checksum

The pipeline downloads two tools: `actionlint` and `gitleaks`. The action `actions/install-tool` installs them.
It reads the pin of the tool in `actions/install-tool/tools.txt`. A pin has the tool, the version, the platform, the url and a SHA-256.
The SHA-256 is the hash of the downloaded archive.

The script downloads the archive and calculates its SHA-256. It compares the result with the pin before it extracts anything.
If the two hashes differ, the script fails and installs nothing. If they match, it extracts the one file with the name of the tool and adds its directory to the `PATH`.

```yaml
- uses: jross24/lab-workflows/actions/install-tool@main
  with:
    tool: actionlint
- run: actionlint
```

### Why a pinned hash and not a checksum file

Each release of these tools also publishes a checksums file. The pipeline does not fetch that file. It comes from the same release page as the archive.
A person who can replace the archive can replace the checksums file too. Then the check proves nothing.

The pin is in this repository. A change to a pin is a pull request that a person reads.
So the trusted value comes from a place that an attacker on the release page cannot change.

The lab chose a pinned download and not a container image digest. The tools are static binaries, so the job pulls no image and starts no daemon.
A pinned download also adds no third-party action to trust.

### The trade-off

A pin does not update itself. Dependabot does not read `tools.txt`. A person must update a tool in one pull request that changes the version, the url and the hash together.

A pin does not prove that the release was clean on the day of the pin. The person who sets the pin checks the hash in three ways.
These are: a download that the person made, the checksums file of the release, and the digest that the GitHub API shows for the file. All three must agree.

### The pins now

| Tool | Version | SHA-256 of the Linux x86_64 archive |
| --- | --- | --- |
| `actionlint` | 1.7.12 | `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` |
| `gitleaks` | 8.30.1 | `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` |

To add or change a tool, edit `tools.txt` and run `bash actions/install-tool/test.sh`.
The CI of this repository downloads both tools on each run. So a wrong hash or a wrong url fails the CI.

## Checks of this repository

The `ci` workflow runs on each pull request. It installs `actionlint` and `gitleaks` with `actions/install-tool`.
It runs the tests of the scripts: next-version, lock, install-tool, changed-paths and secret-scan. It also runs `shellcheck` and `actionlint`.

`actionlint` is not optional. It checks every workflow file in `.github/workflows/`, and it runs `shellcheck` on the `run:` scripts.
Any finding fails the job `check`. `shellcheck` on the scripts still runs only if the runner image has it, and the image has it today.
See [lab-platform#22](https://github.com/jross24/lab-platform/issues/22).
