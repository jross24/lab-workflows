# lab-workflows

This repository holds the shared pipeline of the pipeline lab.
A service repository does not copy the pipeline. It calls the workflows in this repository.

The pipeline has reusable workflows and several composite actions.

| File | What it does |
| --- | --- |
| `.github/workflows/pr.yml` | Checks a pull request: lint, typecheck, tests, `cdk synth`, a dependency check, a secret scan, `actionlint`, the contract check and the `cdk diff` comment. Only the diff job has AWS access, and it can only read. |
| `.github/workflows/release.yml` | Releases a push to `main`: version tag, one build, then Test (with the lock and the E2E gate), Staging and Production. Each environment has checks before the deployment and a smoke check after it. After Production it records the version on the release (the production marker). |
| `.github/workflows/redeploy.yml` | Deploys an old release again. This is the rollback path. It takes the Test lock for Test. After a redeploy to Production it records the version on the release (the production marker). |
| `.github/workflows/check.yml` | A dry run of the checks before a deployment. It deploys nothing. |
| `actions/pipeline-info` | Reads `pipeline.json` of the service repository and gives the name of the service. |
| `actions/preflight` | The checks before a deployment: the providers, the tested set, "no step back" and the rollback floor. The script and its tests are in the same folder. |
| `actions/tested-with` | Makes the record of the versions that passed in Test (`tested-with.json`). |
| `actions/supersede` | Cancels the older releases that wait for the production reviewer. |
| `actions/propose-rollback` | After a failed smoke check in Production, it starts the redeploy of the earlier version. That run waits for the reviewer. It does not start the redeploy if the earlier version is below the rollback floor. |
| `actions/next-version` | Works out the next version from the commit titles. |
| `actions/deploy` | Deploys one CDK stage from the cloud assembly of the build job. |
| `actions/lock-acquire` | Takes the lock of the shared Test environment. It waits when another release holds the lock. |
| `actions/lock-release` | Releases that lock. It never fails the release. |
| `actions/install-tool` | Installs a tool from a pin: a version, a url and a SHA-256. It checks the download before it uses it. |
| `actions/changed-paths` | Tells whether a pull request changes a file under some paths, for example `.github/`. |
| `.github/workflows/diff.yml` | Shows the `cdk diff` against Production as one comment on a pull request, and blocks a delete of a stateful resource. See "The cdk diff comment". |
| `actions/cdk-diff` | The scripts and the tests behind `diff.yml`. |
| `.github/workflows/preview.yml` | Deploys a temporary environment for a pull request with the label `preview`, and removes it when the pull request closes. See "The temporary environment of a pull request". |
| `.github/workflows/preview-sweeper.yml` | Removes the previews of closed pull requests and the previews that are too old. It runs every six hours. |
| `actions/preview` | The scripts and the tests behind the two preview workflows. |
| `actions/secret-scan` | Scans the commits of a pull request for secrets with `gitleaks`. It never prints a secret. |
| `actions/contract-check` | Checks the files `contract.json` and `expectations.json` of a service against the releases that run in Production. It needs no AWS access. See "Contract tests". |
| `actions/contract` | The scripts and the tests behind `contract-check`. |
| `actions/record-production` | Writes the production marker `deployed-production.json` and uploads it to the GitHub release. See "Contract tests". |

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

1. `version` reads `pipeline.json`, works out the next version and creates the tag on the released commit.
2. `build` runs `npm ci`, lint, typecheck, the tests and one `cdk synth -c version=<version>`. It uploads the zip as a workflow artefact. It also attaches the zip to a GitHub release with the name of the tag. If the repository has `contract.json` or `expectations.json`, it attaches them too.
3. `lock-test` takes the lock of the Test environment. It waits when another release holds the lock.
4. `deploy-test` makes sure that this run holds the lock, runs the checks before a deployment, and deploys the stage `Test` in the GitHub environment `test`.
5. `e2e` runs the end-to-end suite of [lab-e2e](https://github.com/jross24/lab-e2e) against Test.
6. `tested-set` records the four versions that the suite tested. A release of another service adds its own version. The job attaches the record to the GitHub release as `tested-with.json`.
7. `unlock-test` releases the lock. It runs after a pass, after a failure and after a cancel.
8. `deploy-staging` runs the checks, deploys the stage `Staging` in the GitHub environment `staging`, and runs the smoke subset of the E2E suite. It starts only if `e2e` and `tested-set` passed. With `run-e2e: false` it starts after `deploy-test` passed.
9. `supersede` cancels the older releases of this repository that still wait for the production reviewer.
10. `deploy-production` runs the checks, deploys the stage `Production` in the GitHub environment `production`, and runs the smoke subset. If the smoke subset fails, it proposes the way back.
11. `record-production` runs only if `deploy-production` passed. It attaches the production marker `deployed-production.json` to the GitHub release. See "Contract tests".

`e2e-summary` runs when `e2e` ran. It writes the versions that the E2E run tested into the summary of the release. With `run-e2e: false` it does not run.

```
version -> build -> lock-test -> deploy-test -> e2e -> tested-set --+
                                        \          \-> unlock-test  |
                                         \-------------------------\|
                                                                    v
                                     deploy-staging -> supersede -> deploy-production -> record-production
                                     (checks, deploy, smoke)        (checks, deploy, smoke)   (marker)
```

Each deploy job starts only after the jobs before it passed. With `run-e2e: false`, `deploy-staging` accepts the skipped `e2e` job, but only after `deploy-test` passed.
If the `production` environment has a required reviewer, `deploy-production` waits until that person approves it.
`record-production` needs no AWS access and no approval. A failed smoke check fails `deploy-production`, so `record-production` does not run and the release gets no marker.

The jobs are not one queue. Each job that changes an environment has its own concurrency group. The section "Releases in order" explains the groups.
The caller must not set a `concurrency` group for the whole run.

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
| `version` | 10 minutes | A job of a few seconds. |
| `build` | 20 minutes | `npm ci`, the tests and `cdk synth` need a few minutes. |
| `lock-test` | 25 minutes | The wait for the Test lock is 20 minutes at most. |
| `deploy-test` | 15 minutes | Part of the time budget of the lock (see "The time budget of the lock"). It is 15 and not 10 because the first deployment of CloudWatch Transaction Search in an account waits about 6 minutes for the setting. The checks and the step that makes sure the run holds the lock take a few seconds and are inside the 15. |
| `unlock-test` | 5 minutes | A short job. GitHub ends a cancelled job after 5 minutes. |
| `tested-set` | 5 minutes | A job of a few seconds. It does not hold the lock. |
| `e2e-summary` | 5 minutes | A job of a few seconds. |
| `deploy-staging` | 25 minutes | 15 for the deployment, like Test, and 10 for the checks and the smoke subset. The smoke subset needs about 2 minutes. |
| `supersede` | 5 minutes | A job of a few seconds. |
| `deploy-production` | 40 minutes | 30 for the deployment (see below) and 10 for the checks and the smoke subset. |
| `record-production` | 5 minutes | A job of a few seconds. It uploads one small file. |
| `redeploy` (in `redeploy.yml`) | 15, 25 or 40 minutes | For Test, Staging or Production. The same limits as the release jobs. |
| `lock` (in `redeploy.yml`) | 25 minutes | The wait for the Test lock is 20 minutes at most. |
| `record` (in `redeploy.yml`) | 5 minutes | A job of a few seconds. It uploads one small file. |

A service can release with CodeDeploy: the traffic of a Lambda alias moves to the new version in steps, and an alarm rolls it back.
CloudFormation waits for the CodeDeploy deployment, so the job `cdk deploy` waits too. A canary of "10 percent for 5 minutes" alone takes 5 minutes.
The deployment part of the limit of `deploy-production` is 30 minutes. It leaves room for the stack update, for the canary and for a rollback of the traffic and of the stack.
A job that waits for a required reviewer has not started, so that wait does not count against the limit.
A composite action cannot set a limit for its own steps. So the smoke subset has no limit of its own. Its tests have limits (30 seconds for a test, 90 seconds for the warm-up), and the limit of the job covers the rest.

The part of `deploy-test` that holds the lock did not change. The lock budget is therefore the same as before.

## The end-to-end gate

After `deploy-test`, the job `e2e` calls the workflow `run.yml` of [lab-e2e](https://github.com/jross24/lab-e2e) for the environment `test`.
It passes the service and the version of the release. The suite loads the page of web and calls the public APIs. It checks that the versions on the page equal the versions that the services report.
It also checks that Test reports the version of this release (the release test).
If the suite fails, `deploy-staging` does not start, so the release stops.

`e2e-summary` writes the exact versions that the suite tested into the summary of the release.
The summary of the E2E job itself also lists them, with the commit of lab-e2e.
When the suite fails, the called workflow still gives its outputs to `e2e-summary`. The lab checked this on 2026-10-08 with a test workflow, and in a release run that the fault drill failed on purpose ([account 0.4.10, attempt 1](https://github.com/jross24/lab-svc-account/actions/runs/37771702730)). There the log of `e2e-summary` shows `E2E against Test: failure` and the four versions.
`e2e-summary` writes "not recorded" for an empty output anyway, for example when the suite never ran.

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
A release takes the lock in `lock-test` and gives it back in `unlock-test`. Two other users of Test take the same lock: `redeploy.yml` for a redeploy to Test, and the runs that lab-e2e starts itself. See "Who takes the lock".

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

**Release** (`actions/lock-release`) deletes the item with the condition `begins_with(holder, <run prefix>)`. Any attempt of the same run can delete the lock of the run. This lets attempt 2 release a lock that attempt 1 took, when the release job of attempt 1 failed.
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
| Someone cancels the run | The expression `always()` "causes the step to always execute, and returns true, even when canceled". `unlock-test` has the condition `always() && needs.lock-test.result != 'skipped'`, so it still runs after a cancel, if the job `lock-test` ran. It waits for the job that runs (for example `e2e`) to end first, because it needs it. The cancel reference says that GitHub ends all jobs that still run 5 minutes after the cancel. |
| A runner dies, or GitHub force-cancels the run | `unlock-test` may not run. The lock ends by itself after 40 minutes. This is the safety valve. |
| `deploy-test` hangs | The job limit is 15 minutes, less than the 40 minutes of the lock. So the job ends before the lock expires. |
| The lock expires while a release still uses Test | Another release can take the lock. Both then use Test. The time budget above (29 minutes at most for 40 minutes of lock) makes this unlikely. |
| A person starts "Re-run failed jobs" after a failed `deploy-test` or a failed E2E suite | See "A re-run of failed jobs" below. The re-run takes the lock again, or it stops with an instruction. |
| A redeploy to Test, or a run of lab-e2e, meets a release | It waits for the lock. See below. |
| `lock-test` is cancelled while it waits for the group, because a newer release replaced its run | `unlock-test` still starts, because the job did not skip. It finds that another run holds the lock, or that no lock exists, and warns. It deletes only a lock of its own run. |

### Who takes the lock

| User | How | When the lock is taken by another run |
| --- | --- | --- |
| A release | `lock-test` before `deploy-test`, `unlock-test` after the suite | It waits up to 20 minutes. Then the job fails and someone starts the release again. |
| A redeploy to Test (`redeploy.yml`) | The job `lock` before `redeploy`, the job `unlock` after it | It waits up to 20 minutes. Then it fails. A rollback to Test is not urgent. A redeploy to Staging or Production takes no lock. |
| A run that lab-e2e starts itself (push to `main`, schedule, manual run) | The job `lock` of `run.yml`, the job `unlock` after the suite | It waits up to 20 minutes, then **skips** the suite with a notice. It does not fail. A busy Test environment says nothing about the code, and a red nightly run teaches people to ignore red runs. The input `lock-wait-minutes` of a manual run makes the wait shorter. |

The lock is one item. A holder is `<repository>#<run id>#<attempt>`. GitHub gives a nested workflow the `github` context of the caller. So inside a release, the E2E suite has the same holder as `lock-test`. Taking the lock again is then a no-op that starts the expiry again.

### A re-run of failed jobs

"Re-run failed jobs" runs again the failed jobs and the jobs that need them. It does not run `lock-test` again, because that job passed. But `unlock-test` of the first attempt released the lock.
A re-run of `deploy-test` or `e2e` would then use Test without the lock. Two steps close this gap:

- `deploy-test` and the job `suite` of `run.yml` start with the step "make sure this run holds the lock". It calls `lock-acquire` with `max-wait-minutes: 0`.
- In the first attempt the step is a no-op: the run holds the lock, and the call only starts the expiry again.
- After a re-run the lock is gone. If Test is free, the step takes the lock again. `unlock-test` needs `e2e`, so it runs again and releases the lock at the end.
- If another run holds the lock, the step fails at once. It does not wait, because the job limits and the time budget of the lock count on a short job. The message says: wait until that run has ended, then re-run the failed jobs again.

The same holds for `redeploy.yml`, with the job `lock`.

### What the lock does not solve

- **The lock is not a queue.** Waiting releases poll. The release that polls first after the lock ends wins. There is no order and no fairness between repositories. Inside one repository, the group `release-test-queue` lets only one release poll at a time.
- **The clock of the runner decides.** The expiry compares the clocks of different runners. GitHub synchronises them, and the margin is 11 minutes, so a few seconds of drift do not matter.
- **The lock covers Test only.** Staging and Production have no lock table. The concurrency groups of each repository order the deployments there, and the check "no step back" keeps an environment from going back. Two repositories can deploy to Staging at the same time, because they deploy different stacks.
- **A set of versions that passed in Test can differ from the set in Staging and Production.** The lock does not pin it. The tested set and its check handle this. See "The tested set".

### The trade-off

A lock makes the releases queue. This has a cost:

- One slow or stuck release delays every team. The wait is up to 20 minutes, and then the next release fails and someone must start it again.
- The expiry is the safety valve. It frees a lock that a dead run holds. The price is a wait of up to 40 minutes after a crash. A release that waits for 20 minutes fails before that, and someone must start it again.
- Every release now needs the lock table, SSM and the E2E repository. More parts can fail.

The alternative is a Test environment for each team or for each change. That costs more, but it needs no queue.

## What is proven and what is not

The column "How" says how the lab proved a claim:

- **Unit test**: a bash test with a fake `aws` or `gh` command and a fake clock. CI runs it. It calls no AWS API.
- **Experiment**: a small scratch workflow in this repository, run on 2026-10-08 and then deleted.
- **Real run**: a release or a redeploy in the lab accounts. The links go to the runs. All times are UTC, on 2026-10-08.

| Claim | How | Result |
| --- | --- | --- |
| Version ranges, the comparison of versions (also `0.10.0` against `0.9.0` and leading zeros), the verdicts of the checks, the parsing of `pipeline.json` | Unit test (`actions/preflight/test.sh`) | Pass. |
| The decision of `supersede` (which runs it cancels, which it leaves) and of `propose-rollback` | Unit test | Pass. |
| The lock: acquire, wait, skip, `fresh`, release by any attempt of the run | Unit test (`actions/lock/test.sh`) | Pass. |
| The conditional writes against the real DynamoDB table, and the lock between real runs | Real run | The lock was taken and released in every run below. The poller of the table (a read-only call) showed one holder at a time. |
| The checks pass for a normal release, in Test, Staging and Production, and the tested set is recorded | Real run ([account 0.4.2](https://github.com/jross24/lab-svc-account/actions/runs/37758177862)) | The summary of each deploy job has the table of the checks. `tested-set` attached `tested-with.json` to the release. |
| The version parameter shows the new version when the release is complete | Real run (production canary of account 0.4.2) | During the canary the stack was `UPDATE_IN_PROGRESS` and `/lab/account/version` still held `0.4.1`. At `UPDATE_COMPLETE` it held `0.4.2`. |
| A provider requirement that cannot be met stops a deployment with a clear message (issue 16) | Real run, the dry run [check.yml](https://github.com/jross24/lab-svc-account/actions/runs/37770650320) with `requires={"core":">=9.9.9"}` against Staging | `account needs core >=9.9.9, but staging runs core 0.6.1, which is outside the range.` The job failed. Nothing was deployed, and `main` did not change. |
| A neighbour that is older than the tested set stops a release (issue 21) | Real run ([account 0.4.8](https://github.com/jross24/lab-svc-account/actions/runs/37768086830), attempt 1) | web 0.4.2 was held at the production gate. The account release was tested next to it. Its production job failed with `Missing release` and did not deploy. |
| The same release goes on when the missing release is in the environment (issue 21) | Real run (the same run, attempt 2) | After web 0.4.2 reached Production, "Re-run failed jobs" passed the check (`web 0.4.2 / 0.4.2 ok: the same version`) and deployed. |
| A failed suite stops `deploy-staging` and the lock is released (issue 20) | Real run ([account 0.4.3](https://github.com/jross24/lab-svc-account/actions/runs/37761504619), the drill `full-test`) | The suite failed on purpose. `unlock-test` passed. `deploy-staging`, `supersede` and `deploy-production` were skipped. The lock was held from 10:09:33 to 10:12:29 and then gone. |
| A failed called workflow gives its outputs to the caller | Experiment, and a real run ([account 0.4.10, attempt 1](https://github.com/jross24/lab-svc-account/actions/runs/37771702730), drill `full-test`) | Yes. The job `e2e-summary` printed the four versions after the suite failed. This was not clear from the documentation. |
| A cancel during `e2e` still runs `unlock-test` (issue 20) | Real run ([account 0.4.5](https://github.com/jross24/lab-svc-account/actions/runs/37763451461)) | Cancelled at 10:29:08. The suite ended at 10:29:44. `unlock-test` ran and passed. The lock was gone at 10:29:53. Everything after the suite was cancelled. |
| "Re-run failed jobs" after a failed suite takes the lock again, and `unlock-test` runs again (issue 19) | Real run (the run of 0.4.3, attempt 2) | The holder text ended with `#2` from 10:13:45 to 10:14:40. Then the release went on to Staging. |
| A re-run meets a lock that another run holds: the step fails and says what to do | Real run ([account 0.4.10](https://github.com/jross24/lab-svc-account/actions/runs/37771702730), attempt 2) | `The Test environment is locked, and this step does not wait.` The lock was held by a web release. Attempt 3 passed after the web release had ended. |
| A redeploy to Test takes the lock and waits for a release (issue 24) | Real run ([redeploy 0.4.9](https://github.com/jross24/lab-svc-account/actions/runs/37771007792)) | The job `lock` waited 2 min 41 s for the release. The lock changed from the release to the redeploy and then to nobody. |
| A run that lab-e2e starts waits for a release, then goes on (issue 19) | Real run ([push to main of lab-e2e](https://github.com/jross24/lab-e2e/actions/runs/37757001017)) | The job `lock` waited 4 min 22 s. It named the holder in the log, then ran the suite. |
| A run that lab-e2e starts skips the suite with a notice when the wait is over (issue 19) | Real run ([manual run with `lock-wait-minutes=1`](https://github.com/jross24/lab-e2e/actions/runs/37771012232)) | The job `lock` ended after 1 min 13 s. `suite` and `unlock` were skipped. The run is green. |
| A failed smoke check in Staging stops the promotion (issue 31) | Real run ([account 0.4.6](https://github.com/jross24/lab-svc-account/actions/runs/37764186112), the drill `smoke-staging`) | `deploy-staging` failed after the deployment. `supersede` and `deploy-production` were skipped. |
| A failed smoke check in Production fails the job loud and proposes the way back (issue 31) | Real run ([account 0.4.7](https://github.com/jross24/lab-svc-account/actions/runs/37765579041), the drill `smoke-production`) | The job `deploy-production` failed. The summary named the way back. The redeploy of 0.4.4 started and waited for the reviewer ([run 37767421525](https://github.com/jross24/lab-svc-account/actions/runs/37767421525)). The lab cancelled it, as a false alarm. Production kept 0.4.7. |
| The second change reaches Test and Staging while the first waits for Production (issue 14) | Real run (account 0.4.3 waited from 10:17:05; [account 0.4.4](https://github.com/jross24/lab-svc-account/actions/runs/37762494985) started at 10:17:42 and reached the gate at 10:23:55) | Yes. With the old design it would have waited until someone answered the first release. |
| The workflows from `main` work in all four services | Real run (the first release of each service with `release.yml@main`: [core 0.6.2](https://github.com/jross24/lab-svc-core/actions/runs/37777414907), [account 0.4.13](https://github.com/jross24/lab-svc-account/actions/runs/37777361298), [catalogue 0.6.1](https://github.com/jross24/lab-svc-catalogue/actions/runs/37780180133), [web 0.4.4](https://github.com/jross24/lab-web/actions/runs/37777371298)) | All four passed the checks and the smoke subset in Staging and Production. After them the three environments hold core 0.6.2, account 0.4.13, catalogue 0.6.1 and web 0.4.4. |
| The tested set check stops a release without a drill (issue 21) | Real run (the same run of core 0.6.2, attempt 1) | The suite tested core next to web 0.4.4, and Production still ran web 0.4.3 (that release was in its canary). The job failed with `Missing release` and did not deploy. After web 0.4.4 reached Production, "Re-run failed jobs" passed. See [lab-platform#47](https://github.com/jross24/lab-platform/issues/47). |
| A newer release cancels the older release that waits for the reviewer (issue 14) | Real run (the job `supersede` of account 0.4.4) | `Cancelled run .../37761504619. It waited for the production reviewer, and v0.4.4 contains its changes.` Production history of `/lab/account/version`: 0.4.2, 0.4.4. The version 0.4.3 never reached Production. |
| Production receives releases in order, also when a release is still in its canary (issue 14) | Real run (accounts 0.4.10, 0.4.11 and 0.4.12, see the timeline below) | The production job of each newer release was `pending` while the older one deployed. It started after the older one ended. |
| A job that waits for environment approval holds its concurrency group; a third release replaces a second one | Experiment, and the runs above | Yes, as the GitHub documentation says. |
| `queue: max` keeps the pending jobs in order and cancels none | Experiment (four pushes) | Yes. It is not used. |
| A second job in the `production` environment asks for a second approval | Experiment | Yes. This is why the smoke check is a step in the deploy job. |
| The nested call `release.yml` -> `run.yml` (environment, secrets, OIDC identity) | Real run, since 2026-10-07 and in every run above | Works as the section "How the nested call finds its environment, secrets and OIDC identity" says. |
| A concurrency group is limited to one repository | Not tested with two repositories. | The documentation says so. The four services run their own jobs in their own groups, and the Test lock is the shared part. |
| A force-cancel of the run, or a dead runner, leaves the lock until the expiry | Not tested. | From the documentation. The lock ends by itself after 40 minutes. |
| "Re-run all jobs" of a release | Not run. | The job `build` replaces the release files and the artefact when the release exists. The lab changed the job for this, and ran only "Re-run failed jobs". |
| `redeploy.yml` to Production, with the checks and the smoke check | Not run with an approval. The redeploy that `propose-rollback` started was cancelled. | The same workflow ran to Test (above). The reviewer step is the only difference. |

### The timeline of three releases in order

The lab merged three small pull requests of lab-svc-account in a row. Each release passed Test and Staging at its own pace. The log below lists the state of the job `deploy-production` of each release (UTC, 2026-10-08).

| Time | Event |
| --- | --- |
| 12:03:05 | Account 0.4.10 ([run 37771702730](https://github.com/jross24/lab-svc-account/actions/runs/37771702730)) deploys to Production (the canary runs). |
| 12:09:15 | Account 0.4.11 ([run 37774071710](https://github.com/jross24/lab-svc-account/actions/runs/37774071710)) has passed Staging. Its production job is `pending` in the group. |
| 12:09:53 | 0.4.10 is done. |
| 12:09:54 | 0.4.11 deploys to Production. |
| 12:12:33 | Account 0.4.12 ([run 37774128271](https://github.com/jross24/lab-svc-account/actions/runs/37774128271)) has passed Staging. Its production job is `pending` behind 0.4.11. |
| 12:16:51 | 0.4.11 is done. |
| 12:16:52 | 0.4.12 waits for the reviewer. It asks only now. |
| 12:17:12 | 0.4.12 deploys to Production. |

The history of the parameter `/lab/account/version` in the Production account shows the same order: 0.4.8, 0.4.9, 0.4.10, 0.4.11, 0.4.12. Earlier in the day it showed 0.4.2 and then 0.4.4. The versions 0.4.3, 0.4.5 and 0.4.6 never reached Production: the first was cancelled by the next release, the second was cancelled by the lab, and the third failed a smoke check in Staging.

## The redeploy workflow

`redeploy.yml` has two inputs: `version` and `environment`.
It downloads the zip of that version from the GitHub release. It checks the zip against the SHA-256 file of the release.
Then it deploys the zip to that environment. It does not build.

Use it to go back to an old version. The old version is the old artefact, not a new build of old code.
For a service that releases in steps, a redeploy moves the traffic in steps too. A redeploy to `production` takes more than 5 minutes.
The rules of the GitHub environment apply to a redeploy too. A redeploy to `production` waits for the reviewer.

A redeploy follows the same rules as a release in these places:

- **The Test lock.** A redeploy to `test` has the job `lock` before the deployment and the job `unlock` after it. It waits up to 20 minutes for a release that uses Test, then it fails. A redeploy to Staging or Production takes no lock.
- **The concurrency group.** The job `redeploy` uses the group `deploy-<environment>`, the same group as the release jobs `deploy-staging` and `deploy-production`. A redeploy and a release of one repository never deploy to one environment at the same time. To roll back while a release waits for the reviewer in Production, reject or cancel the waiting release first.
- **The checks before the deployment**, in the mode `redeploy`. A provider that is missing or too old still stops the redeploy, because the stack would fail. The check "no step back" does not stop it, because going back is the aim. The tested set does not stop it either. A rollback must not wait for a neighbour. The table of the summary shows an older neighbour as a warning.
  The record of the tested set comes from `tested-with.json` of the GitHub release. A release from before the record has none, and the check says so.
- **The rollback floor.** A redeploy stops when its version is older than the rollback floor of the environment. The check reads the SSM parameter `/lab/<service>/min-rollback-version` and fails with `Rollback refused`. It runs before the deployment, and for Test after the lock, so a refused redeploy changes nothing. A service with no such parameter has no floor. See "The rollback floor" and "Rollback and data".
- **`pipeline.json`.** A tag from before the checks has no such file. Then the redeploy reads the file of the default branch and says so in a notice.
- **The smoke check.** A redeploy to Staging or Production runs the smoke subset after the deployment, for the version that it deployed. A redeploy to Test does not, because Test has the full suite in the release.
- **The production marker.** After a redeploy to Production, the job `record` attaches the marker `deployed-production.json` to the release of the version that it deployed. It runs only if the job `redeploy` passed, so a failed smoke check leaves no marker. The job needs no approval and no AWS access. It needs `contents: write`, and so the caller must give it. A redeploy to Test or Staging writes no marker. See "Contract tests".

## Rollback and data

A rollback restores code, not data. So the lab has three rules:

1. A change to a data shape takes two releases. This section explains the rule.
2. The pipeline blocks a destructive change to a data store unless a person acknowledges it. See "The stateful change guard".
3. The rollback path refuses a version that cannot read the current data. See "The rollback floor".

In the lab only `core` has data, so only `core` has a rollback floor.

### A rollback restores code, not data

A rollback puts the old code back. It does not put the old data back.
The data keeps every change that the new code and its migrations made. So a rollback is safe only when the old code can read the data as it is now.

### One change to a data shape takes two releases

The two releases are "expand" and "contract". The first release adds, and the second release removes.

1. **Expand.** Release 1 adds the new shape next to the old shape. The new code writes both shapes and reads either one. Nothing is removed, so the previous version still reads all the data and a rollback is safe.
2. **Contract.** Release 2 comes later, when Production runs release 1 and the data has the new shape. Release 2 reads only the new shape and removes the old shape.

For example, take a rename of the attribute `name` to `title`. Release 1 writes both attributes, and it reads `title`, or `name` when `title` is missing. Release 2 reads only `title`, and it deletes `name`.
One release must not do both steps. If it did, the previous version would meet data that it cannot read at the moment of a rollback.
After release 2 the floor is release 1. Release 0 reads only `name`, which is gone, so a redeploy of release 0 is refused.

### Why a contract release is safe against the automatic rollback of the canary

A release to Production moves the traffic in steps with CodeDeploy (a canary). When an alarm fires, CodeDeploy moves the alias back to the previous Lambda version by itself.
This rollback does not use `redeploy.yml`. So the check of the rollback floor does not see it, and two other rules must make it safe:

- **The contract release must itself read the data that the previous version wrote.** During the canary both versions run on the same data. The previous version is an expand release, so it also reads what the contract release writes.
- **Destructive steps run only after the canary has finished.** CloudFormation waits for the CodeDeploy deployment of the alias before it updates the next resource. A destructive resource depends on the alias, so it starts only when the canary has passed. If the canary rolls back, the destructive step never runs and the data keeps its old shape.

The rollback floor guards the other path: a redeploy that a person starts, or that `propose-rollback` starts.

### The order of the migration steps

Additive (expand) migrations run before the new code takes traffic: the stack resource `MigrationsExpand` runs before the alias is updated.
Destructive (contract) migrations run after the canary has finished: the resource `MigrationsContract` depends on the alias, so CloudFormation waits for the CodeDeploy deployment first.
A destructive migration records the new rollback floor before its first write, and the floor never goes down.

The stack of the service must implement this order. This repository only checks the result: it reads the floor and refuses a rollback below it.

### Where the rollback floor lives

The rollback floor lives with the data: the SSM parameter `/lab/<service>/min-rollback-version` in the account of each environment.
A redeploy applies the old stack again, so the old stack cannot hold the floor: it was built before the migration that raised it.
So the migration step of the service writes the floor, and it never lowers it.

## Use the pipeline in a service repository

Add three small workflow files to the service repository.

```yaml
# .github/workflows/pr.yml
name: pr
on:
  pull_request:
permissions:
  contents: read
  id-token: write # the diff job reads the deployed stack with an OIDC token
  pull-requests: write # the diff job writes one comment
jobs:
  pr:
    uses: jross24/lab-workflows/.github/workflows/pr.yml@main
    secrets: inherit
```

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    branches: [main]
# No concurrency group here. release.yml orders the releases job by job. See "Releases in order".
permissions:
  contents: write # the version tag and the GitHub release
  id-token: write # the OIDC login to AWS
  actions: write # a newer release cancels an older release that waits for the production reviewer
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
  contents: write # the job record attaches the production marker to the release
  id-token: write
jobs:
  redeploy:
    uses: jross24/lab-workflows/.github/workflows/redeploy.yml@main
    with:
      version: ${{ inputs.version }}
      environment: ${{ inputs.environment }}
    secrets: inherit
```

The file must be named `redeploy.yml`. After a failed smoke check in Production, `release.yml` starts the workflow with this name.

A fourth file is optional. It starts a dry run of the checks:

```yaml
# .github/workflows/check.yml
name: check
on:
  workflow_dispatch:
    inputs:
      environment:
        description: The environment to read
        required: true
        type: choice
        options: [test, staging, production]
      version:
        description: The version to check, for example 1.2.3
        required: false
        type: string
      requires:
        description: 'A JSON object that replaces "requires" for this run only'
        required: false
        type: string
permissions:
  contents: read
  id-token: write
jobs:
  check:
    uses: jross24/lab-workflows/.github/workflows/check.yml@main
    with:
      environment: ${{ inputs.environment }}
      version: ${{ inputs.version }}
      requires: ${{ inputs.requires }}
    secrets: inherit
```

The service repository must have these things:

- The npm scripts `lint`, `typecheck` and `test`, and a committed `package-lock.json`.
- A CDK app that makes the stages `Test`, `Staging` and `Production` in one `cdk synth`. The stacks have no account and no region in the code.
- A context value `version`. The app puts it in a stack output named `Version`, and in the SSM parameter `/lab/<service>/version`.
- The file `pipeline.json` (see "The file `pipeline.json`").
- The GitHub environments `test`, `staging` and `production`. Each one has a secret `AWS_ACCOUNT_ID`.
- A repository variable `AWS_REGION`.
- A name that starts with `lab-`. The trust policy of the `github-deploy` role accepts only those repositories.
- The roles of the services that it reads: `github-deploy` needs `ssm:GetParameters` on `/lab/*` in each account (lab-platform).
- Optional: `contract.json` for a provider, `expectations.json` for a consumer, and the label `breaking-change-approved` (see "Contract tests").

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
The job `fetch` reads the output `Version` from the deployed template (not from the stack outputs, which lag during a deployment). The job `compute` synthesises with `-c version=<that version>`.
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
- `cdk diff --template` compares one stack only. A stack that depends on another stack of the app makes the CLI select both, and it stops with "Can only select one stack". The workflow passes `--exclusively`.
- The name of a workflow artefact must be unique in a run. The platform repository calls `diff.yml` four times in one run, once for each account. The first version used the name `deployed` in all four calls.
  Each `compute` job then downloaded the templates of another account, and the diff showed every resource as new. The artefact names now hold the `key` of the call.

## The temporary environment of a pull request

A pull request with the label `preview` gets its own copy of the service in the developer account (`lab-dev`).
The workflow `preview.yml` deploys the `Dev` stage of the service under a name that belongs to the pull request.
A comment on the pull request shows the URL. A push deploys the new commit. The preview goes when the pull request closes or when the label goes.
Today the repository [lab-svc-catalogue](https://github.com/jross24/lab-svc-catalogue) uses it. It is the reference implementation.

### The names

The pipeline uses the namespace `pr-<number>`. The service builds all its names from the namespace. Two pull requests, or a pull request and a laptop deployment, never share a name.

| What | Name for pull request 12 of lab-svc-catalogue |
| --- | --- |
| Namespace | `pr-12` |
| Stack | `lab-svc-catalogue-pr-12` |
| SSM parameter of the URL | `/lab/ns/pr-12/catalogue/url` |
| Dashboard | `lab-svc-catalogue-pr-12` |
| Version (a metric dimension, so the alarms stay apart) | `0.0.0-pr12.<first 7 characters of the commit>` |
| Tags of the stack | `lab-preview-repo=jross24/lab-svc-catalogue`, `lab-preview-pr=12` |

A developer who deploys from a laptop picks another namespace, for example `-c namespace=jonathan`. The namespace `pr-<number>` is reserved for the pipeline.
The baseline copy of the service has no namespace. It keeps the plain names (`lab-svc-catalogue`, `/lab/catalogue/url`).

### How a preview finds the service it calls

A preview of a consumer needs its provider. The catalogue calls core.
The lab keeps a long-lived baseline copy of all four services in `lab-dev`. A developer deployed it from a laptop with `cdk deploy -c dev=true "Dev/*"`. This is the "developer account baseline".
A preview reads `/lab/core/url` and `/lab/core/api-arn` of the baseline, like every `Dev` stage does. So a preview of the catalogue calls the baseline core.

The trade-off: a preview tests a change of the catalogue against the baseline core, and not against a change of core in a pull request.
To test both together, core needs the namespace too, and the consumer needs a `coreNamespace` context value. Issue [lab-platform#36](https://github.com/jross24/lab-platform/issues/36) lists the work.

### The jobs

| Job | What it holds | What it runs |
| --- | --- | --- |
| `plan` | Nothing | A script of this repository. It reads the event and decides: deploy, destroy or nothing. |
| `build` | Nothing (no AWS credentials, no write token) | The code of the pull request: `npm ci` and `cdk synth` with the namespace. Then a check of the stack name. |
| `deploy` | The AWS role `github-preview` | `cdk deploy` of the assembly from `build`. Then a smoke test: the URL must answer HTTP 200. |
| `destroy` | The AWS role `github-preview`, and the CDK deploy role through it | AWS CLI calls only. It runs no code of the pull request. |
| `comment` | The right to write the one comment | A script of this repository. |

What the event means:

| Event | Result |
| --- | --- |
| A push, or a pull request opened or reopened, with the label | Deploy |
| The label `preview` is added | Deploy |
| The label `preview` is removed | Destroy |
| A pull request with the label closes (merged or not) | Destroy |
| A pull request without the label closes, another label changes, a fork, Dependabot, or no account secret | Nothing. A notice in the log says why. |

A pull request that never had the label needs no AWS login when it closes.

### The sweeper

`preview-sweeper.yml` runs every six hours, and by hand. It lists the stacks of `lab-dev` and removes a preview when its pull request is closed or merged, or when the preview is older than three days.
It is the safety net for a destroy that failed or an old pull request that someone forgot. A forgotten preview must not cost money for ever.

The sweeper removes a stack only if its tags say it is a preview AND its name fits the tags (`<repository>-pr-<number>`). A person could tag the baseline stack with a preview tag. The sweeper skips it and says why.
The role `github-preview-sweeper` can assume the CDK deploy role only, and only the scheduled workflow on `main` of this repository can use it.

### Security note: what stops a pull request from doing harm in `lab-dev`, and what does not

A preview runs the CDK code of a pull request and deploys what the code describes. That is a deployment of unreviewed code, by design.

What stops harm:

- **The account is the fence.** `lab-dev` holds no customer data, no secret and no trust into another account. The baseline services are the only things in it.
- **Who can start it.** The trust policy of `github-preview` accepts a token only from a `pull_request` job of a repository `jross24/lab-*`, and only if the job runs the file `preview.yml` of this repository on `main`. A pull request from a fork gets no token. A job in the repository of the pull request, with a workflow of its own, is refused.
- **What the role can do.** It can assume two roles: the CDK deploy role and the CDK file publishing role of `lab-dev`. It has no other permission.
- **Code and credentials are apart.** The build runs the code of the pull request and has no credential. The deploy job takes only the finished cloud assembly.
- **The names are checked.** The build fails unless the assembly holds exactly one stack, `<repository>-pr-<number>`. Code that does not know the namespace makes the baseline name. The deploy job checks again before it has any credential. The destroy job removes a stack only if its tags name this repository and this pull request.
- **Cost.** A closed pull request removes its preview. The sweeper removes the rest.

What does not stop harm:

- **The CloudFormation execution role has `AdministratorAccess`.** This is the default of `cdk bootstrap`. A template of a pull request can create any resource in `lab-dev`: an IAM user, a large instance, a custom resource that calls any AWS API, even one that removes the baseline.
- **The CDK CLI of the pull request runs with the credentials.** The deploy job installs the CLI from the lockfile of the pull request. It can call the CDK deploy role directly, for example `DeleteStack` on a baseline stack. This gives nothing that the template does not give already.
- **The label is not an authorisation.** A person with write access to the repository can add the label to his own pull request. The label saves cost. It does not protect the account.
- **There is no budget alarm and no service control policy.** A mistake or an attack can cost money until a person sees it.

The lab accepts this because `lab-dev` is a throwaway account and only the owner can open a pull request in a lab repository.
A team would add three things: a custom CloudFormation execution policy with a permissions boundary for the bootstrap of the dev account, a service control policy that limits regions and services, and a budget alarm.

### Adopt it in another service

1. Give the service the `namespace` context value. The README of lab-svc-catalogue has the checklist. Issue [lab-platform#36](https://github.com/jross24/lab-platform/issues/36) lists what core, account and web must change.
2. Add the repository secret `PR_ACCOUNT_ID_DEV` (the ID of the `lab-dev` account) and the label `preview`.
3. Add the caller `.github/workflows/preview.yml`:

```yaml
name: preview
on:
  pull_request:
    types: [opened, reopened, synchronize, labeled, unlabeled, closed]
concurrency:
  group: preview-${{ github.event.pull_request.number }}
  cancel-in-progress: false
permissions:
  contents: read
  id-token: write
  pull-requests: write
jobs:
  preview:
    uses: jross24/lab-workflows/.github/workflows/preview.yml@main
    secrets: inherit
```

The input `smoke-path` is the path that must answer HTTP 200. The default is `/products`.
The stack of the service must have the name `<repository>-<namespace>`, and it must have the output `ApiUrl`.

### What the real runs showed

- The role chain needs `role-skip-session-tagging: true`. `configure-aws-credentials` tags the new session when it chains into another role. A tagged session needs `sts:TagSession` in the trust policy of the target role, and the CDK bootstrap roles do not have it.
  The first destroy failed with `not authorized to perform: sts:TagSession`. The step now skips the tags.
- A workflow with `workflow_dispatch` cannot start from a branch until the file is on the default branch. To test the sweeper, a temporary `push` trigger on the test branch started it.
- `cdk deploy --tags` replaces the tags that the app sets on the stack. The resources keep the tag `lab-namespace`, and the stack keeps the two preview tags.

## What the real runs showed for the diff and the preview

These runs are the evidence. The pull requests were throwaway pull requests. A person closed them without a merge, except for the one pull request that added the preview caller.

| Claim | Run | What it showed |
| --- | --- | --- |
| A pull request can assume `github-pr-diff` only through `diff.yml` on the allowed ref | [lab-svc-catalogue 37752196502](https://github.com/jross24/lab-svc-catalogue/actions/runs/37752196502) | The job in the shared file logged in. A job in another file of this repository, and a job in the service repository itself, got `Not authorized to perform sts:AssumeRoleWithWebIdentity`. |
| The comment against Production | [lab-svc-account 37756392071](https://github.com/jross24/lab-svc-account/actions/runs/37756392071) | All eight checks passed. The comment said "No change" against the real Production stack, with the version read from the deployed template. |
| The comment changes in place | [lab-svc-catalogue 37754254290](https://github.com/jross24/lab-svc-catalogue/actions/runs/37754254290) | A second push changed the same comment. The pull request had one comment. |
| The stateful change guard blocks, against the real Production stack | [lab-svc-catalogue 37761208798](https://github.com/jross24/lab-svc-catalogue/actions/runs/37761208798), attempt 1 | A renamed log group gave `[-] AWS::Logs::LogGroup ... destroy`. The job `report` failed, and the comment named the resource and the label. |
| The label lets it pass | The same run, attempt 2 | After the label `destructive-change-approved` and "Re-run failed jobs", the job passed. The comment said "Approved by the label". |
| No account number leaks | The same run | A search of the 1900 lines of the log and of the comment for the five account IDs and for any run of 12 digits found nothing. |
| The preview life cycle | [deploy 37757139064](https://github.com/jross24/lab-svc-catalogue/actions/runs/37757139064), [push 37757515618](https://github.com/jross24/lab-svc-catalogue/actions/runs/37757515618), [destroy 37758269414](https://github.com/jross24/lab-svc-catalogue/actions/runs/37758269414) | The label deployed the stack `lab-svc-catalogue-pr-13`. The URL answered HTTP 200 with the version `0.0.0-pr13.<commit>` and the data of the baseline core. A push changed the version in the answer. The close removed the stack: `list-stacks` showed `DELETE_COMPLETE`, the parameters under `/lab/ns/pr-13` were gone, and the baseline still answered. |
| The first destroy failed | [37757824926](https://github.com/jross24/lab-svc-catalogue/actions/runs/37757824926) | `not authorized to perform: sts:TagSession`. The chained login now sets `role-skip-session-tagging`. |
| The final caller works from `@main`, and a merge removes the preview | [deploy 37763083614](https://github.com/jross24/lab-svc-catalogue/actions/runs/37763083614), [merge 37763784328](https://github.com/jross24/lab-svc-catalogue/actions/runs/37763784328) | The pull request that added the caller carried the label. Its preview answered with 200. The merge closed the pull request, and the stack `lab-svc-catalogue-pr-15` went to `DELETE_COMPLETE`. |
| The sweeper removes the preview of a closed pull request | [37759838191](https://github.com/jross24/lab-workflows/actions/runs/37759838191) | A stack tagged for the closed pull request 13 stayed behind. The sweeper printed `remove lab-svc-catalogue-pr-13: The pull request is closed.` and removed it. |
| The sweeper removes an old preview | [37760297701](https://github.com/jross24/lab-workflows/actions/runs/37760297701) | With a limit of 0.001 days, it removed the preview of an open pull request. |
| A destroy for a stack that is gone passes | [37760444311](https://github.com/jross24/lab-svc-catalogue/actions/runs/37760444311) | Closing a pull request whose stack the sweeper had removed printed `does not exist. Nothing to remove.` and succeeded. |

What the runs did not prove:

- A pull request from a **fork**. The owner has one GitHub account, and a user cannot fork his own repository. Unit tests cover the decision (`decideRun` and `decidePreview`), and the behaviour of GitHub is from its documentation.
- A **Dependabot** pull request. Unit tests only.
- The sweeper on its **schedule**. The runs above started from a branch with a temporary trigger. The first scheduled run is at the next hour that fits the cron expression.

## The file `pipeline.json`

Each service repository has the file `pipeline.json` at its root. It tells the pipeline which service the repository holds and which other services it needs.

```json
{
  "service": "catalogue",
  "requires": { "core": ">=0.5.0" },
  "compatible": { "web": ">=0.3.0" }
}
```

| Key | Meaning |
| --- | --- |
| `service` | Required. The name of the service: lower case letters, digits and hyphens. It is the same name as in the SSM parameter `/lab/<service>/version`. |
| `requires` | The providers of the service. Each key is a service. Each value is a range. The service cannot be deployed to an environment that has a provider outside its range. |
| `compatible` | Optional. Neighbours that may be older in an environment than in the tested set, as long as they are inside the range. The service does not call them. It only says that it works with the older version. For a neighbour that has a `compatible` range and a `requires` range, the `compatible` range counts. Only the lower side matters: a newer neighbour always goes on, with a notice. |
| `minRollbackVersion` | Optional. A version such as `0.8.0`, as text. Only a service with data sets it. It declares the oldest version that can run against the data after this release. A release fails with `Floor above release` if the key is newer than the release itself. The floor that decides a redeploy is the SSM parameter `/lab/<service>/min-rollback-version`, not this key. See "The rollback floor". |

A service with data declares its rollback floor like this:

```json
{
  "service": "core",
  "minRollbackVersion": "0.8.0"
}
```

A range is one or more comparators with a space between them. All of them must hold. The operators are `>=`, `>`, `<=`, `<` and `=`. A version with no operator means `=`.
Examples: `>=0.5.0`, `>=0.5.0 <1.0.0`, `1.2.3`. A caret range such as `^0.5.0` is not supported. A wrong range stops the release with a message that names the file.

The job `version` reads and checks the file before it makes the tag. A key that the pipeline does not know is an error, so a typo such as `require` does not pass in silence.
The lab names the repository of a service `lab-svc-<service>`, except `web`, which is `lab-web`, and `flags`, which is `lab-flags`. The messages use this rule to say where to release a missing version.

The pipeline files of the four services today:

| Service | `requires` | `compatible` |
| --- | --- | --- |
| core | nothing | nothing |
| catalogue | `core >=0.5.0` | nothing |
| account | `core >=0.5.0` | nothing |
| web | `catalogue >=0.3.0`, `account >=0.3.0` | nothing |

## What each stack publishes: the deployed version

Each service stack writes the SSM parameter `/lab/<service>/version` in its account. The value is the version of the release.
The parameter depends on the alias of the Lambda function in the stack. With a canary, CloudFormation updates the alias, waits for the CodeDeploy deployment, and only then updates the parameter.
So the parameter shows the new version when the release is complete. If the canary rolls back, the stack rolls back and the parameter keeps the old version.
The role `github-deploy` can read these parameters (`ssm:GetParameters` on `/lab/*`). The checks read them in the account of the job.

## The checks before a deployment

Before a deploy job changes an environment, the action `actions/preflight` reads `/lab/<service>/version` of the services that matter, in the account of that environment. It compares them in four ways. Each deploy job runs the checks right before `cdk deploy`. In `deploy-test`, the step that makes sure the run holds the lock comes first.
The result is a table in the job summary and a clear message for each failure. A failure stops the job before `cdk deploy` changes anything.

| Check | Question | Fails when |
| --- | --- | --- |
| No step back | Is this release newer than what the environment runs? | The environment runs a newer version of this service. |
| Providers (issue 16) | Does the environment have each provider of `requires`, inside its range? | A provider has no version in the environment, or its version is outside the range. |
| Tested set (issue 21) | Does the environment have, for each neighbour, at least the version that the E2E suite tested? | A neighbour is older than the tested version and no range accepts it. |
| Rollback floor (issue 33) | Is the version that a redeploy puts into the environment at least the rollback floor? | A redeploy goes to a version below the floor. A release fails here only if `minRollbackVersion` of `pipeline.json` is newer than the release. |

The checks run after the approval of the production reviewer, right before the deployment. They read the state at that time. A reviewer can approve hours after the release started, and the state can change in that time.
A check cannot run before the approval, because the job needs the AWS role of the environment, and the role needs the approval.

### No step back

Releases of one repository can arrive out of order. A late run of an old release could move an environment back. The check compares the version of the release with `/lab/<service>/version`:

- No parameter: the first deployment. It goes on.
- The release is newer: it goes on.
- The same version: it goes on. This is a run again of a release.
- The environment is newer: the job fails with `Release superseded`. The environment keeps its version.

The check uses numbers, not text. `0.10.0` is newer than `0.9.0`.

### Providers

A service reads the SSM parameters of its providers when CloudFormation deploys it. Without the check, a missing provider fails the deployment in the middle of CloudFormation, with an error about a missing parameter.
The check fails early, and the message says what to do. For example:

```
::error title=Provider too old::catalogue needs core >=0.6.0, but production runs core 0.5.1. Release core to production first (repository lab-svc-core), then run this job again.
```

The check also finds the case of a provider that runs in the environment but publishes no version (a stack from before the parameter existed). The message says to release the provider once.
The check does not solve the second effect of issue 16: a consumer keeps the old URL of a provider until its next release. That is a property of CloudFormation, and the README of each service describes it.

### The check of the tested set

The next section explains what the tested set is. The check compares each neighbour in the set with the environment:

| Neighbour in the environment | Result |
| --- | --- |
| The same version as in the tested set | Goes on. |
| Newer than the tested set | Goes on, with a notice. |
| Older, and inside the range of `compatible` or `requires` | Goes on. The table says that `pipeline.json` accepts it. |
| Older, and no range accepts it | The job fails with `Missing release`. The message names the neighbour, the version of the tested set, the version in the environment and the cure. |
| Not deployed (no parameter) | Goes on, with a notice. There is nothing to compare. |

A range in `compatible` is a statement of the owner: "this service works with the older version". The pipeline cannot know it. An undeclared neighbour is strict on purpose.
The failure message looks like this:

```
::error title=Missing release::core 0.5.2 was in the set that the E2E suite tested with web 0.4.0 (release v0.4.0 of web), but production runs core 0.5.1. The repository of core is lab-svc-core. Promote core 0.5.2 to production first, then choose Re-run failed jobs on this run. Or add a `compatible` range for core to pipeline.json if the older version is known to work.
```

The log has this line. The job summary repeats the same text under the heading "What to do", one entry for each neighbour that is too old.

When the missing release reaches the environment, choose **Re-run failed jobs** on the run. The check reads the state again and passes. The decision about ranges is in "Why the check is strict".

### The rollback floor

A rollback restores code, not data. A migration can change the data so that an older version of the code cannot read it. The rollback floor is the oldest version of a service that can still run against the data in an environment.

The section "Rollback and data" explains the reason in more detail.

**Where it is written.** The SSM parameter `/lab/<service>/min-rollback-version` holds the floor, in the account of each environment. The value is a version such as `0.8.0`. Only a service with data has the parameter. In the lab this is `core`.

**Who writes it.** The migration step of the service stack writes the parameter during the deployment. It writes the new floor before the first destructive write, and it never lowers the floor. The role `github-deploy` only reads the parameter (`ssm:GetParameter` and `ssm:GetParameters` on `/lab/*`).

**What the check does.** A redeploy with a version reads the parameter. It compares the value with the version that the redeploy would deploy:

| The parameter in the environment | Result |
| --- | --- |
| It does not exist | Goes on. The table says `ok: no floor recorded`. A service with no data has no floor. |
| The floor is the version or older | Goes on. |
| The floor is newer than the version | The job fails with `Rollback refused`. The deployment does not start. |
| The value is not a version | The check stops with an error that says "This is not a result of the check". It makes no guess. |
| AWS gives another error (no login, no permission) | The same. Only the error `ParameterNotFound` means "no floor". |

The refusal looks like this:

```
::error title=Rollback refused::Rollback refused: core 0.7.0 cannot run against the data in production. A migration changed the data in a way that an older version cannot read. The oldest version that can run is core 0.8.0 (SSM parameter /lab/core/min-rollback-version). Do not roll back to 0.7.0. Go back to 0.8.0 or newer, or fix forward with a new release. If the data itself is wrong, restore it first: see "Restore" in the README of lab-svc-core.
```

Two more places use the floor:

- **A release.** The key `minRollbackVersion` of `pipeline.json` cannot be newer than the release that declares it. If it is, the job fails with `Floor above release`. A release does not read the SSM parameter.
- **A failed smoke check in Production.** `propose-rollback` reads the parameter before it starts the redeploy. If the earlier version is below the floor, it does not start the redeploy. See "A failed smoke check in Production".

A dry run (`check.yml`) has no version, so it does not compare the floor.
The action `preflight` gives the value that it read in the output `min-rollback-version`. The output is empty for a release and for a dry run.

**What the person does next.** The message gives three ways. Pick one:

1. Go back to the floor or to a newer version. The redeploy of that version is not refused.
2. Fix forward. Fix the fault in the code and make a new release.
3. If the data itself is wrong, restore the data first. The README of the service repository describes the restore in the section "Restore". Then decide again.

**What the floor does not do.**

- It does not restore data. It only refuses a rollback that cannot work.
- It does not check that the data is readable. It compares version numbers. It trusts the migration step to write the floor, and to write it before the first destructive write.
- A service with no parameter has no protection. If the migration step forgets to write the floor, the check sees "no floor" and lets the redeploy go.
- It does not stop the automatic rollback of the canary. CodeDeploy does that without `redeploy.yml`. The order of the migration steps makes it safe (see "Rollback and data").
- It does not stop a person who changes the stack outside the pipeline.

The lab tested the comparison, the messages and the decision of `propose-rollback` with unit tests and a fake `aws` command. A real run against SSM is not part of the proof yet.

### A dry run: `check.yml`

The reusable workflow `check.yml` runs the same checks and deploys nothing. A service repository can call it from a `workflow_dispatch` workflow.
The input `requires` replaces `requires` of `pipeline.json` for that run only. So a person can see the failure message of a check without a release and without a change to `main`:

```
gh workflow run check.yml --repo jross24/lab-svc-account -f environment=production -f requires='{"core":">=9.9.9"}'
```

The job runs in the GitHub environment of the input. A dry run against `production` waits for the production reviewer, like every job in that environment.

## The tested set

The E2E suite tests the set of versions that is in Test at that time. The lock makes the result belong to one release. But each service repository promotes by itself. Staging can hold another set than Test, and Production a third one. "It passed in Test" does not mean "this set works in Production".

The pipeline now carries the record of what passed:

1. The suite reports the version of web, catalogue, account and core that it observed.
2. The job `tested-set` checks that the record is complete and that the suite tested **this** release (the version of the service itself must be the version of the release). It fails otherwise, and Staging does not start.
3. The record is the output `json` of the job. It is also the file `tested-with.json` on the GitHub release of the tag. A redeploy reads the file from there.
4. `deploy-staging` and `deploy-production` compare the record with `/lab/<service>/version` of their own environment (see "The checks before a deployment").

The record has this form:

```json
{"release":"v0.4.0","service":"web","version":"0.4.0","commit":"<sha>","e2eCommit":"<sha>",
 "versions":{"web":"0.4.0","catalogue":"0.3.1","account":"0.3.1","core":"0.5.1"}}
```

The suite reports web, catalogue, account and core only, so a release of another service, such as `flags`, has no version in the report. The record of that release also holds its own version, for example `"flags":"0.1.0"`. The check reads that entry like any other one.

### What this guarantees, and what it does not

It guarantees this: **when a release goes to an environment that has a version of a neighbour, that neighbour is the same version as in the tested set, or newer, or older but accepted by the owner in `pipeline.json`.** A release cannot reach Production next to an older neighbour that nobody looked at.
The message names the missing release, so the person knows what to promote first.
The guarantee has gaps on purpose: a neighbour with no version in the environment only gives a notice, a release with `run-e2e: false` has no record to compare, and a redeploy only warns.

It does not guarantee these things:

- It does not test the set in Staging or in Production. It compares version numbers. The smoke subset checks the live system after the deployment, but it is small.
- It does not know whether a newer neighbour still works with this release. An upper bound in a range of `compatible` has no effect for the same reason. A newer neighbour only gives a notice. The contract tests (see "Contract tests", and [lab-platform#34](https://github.com/jross24/lab-platform/issues/34)) are the tool for that.
- It trusts the owner who writes a range in `pipeline.json`.
- It reads versions from SSM. A parameter that a person changed by hand would give a wrong answer. The role of the pipeline cannot write the parameters, and only the stack writes them.
- Between the check and the deployment there are a few seconds. Another release of another repository can deploy in that time.

### Why the check is strict

Decision of the owner (2026-10-08, [lab-platform#47](https://github.com/jross24/lab-platform/issues/47)): the check stays strict, and no service has a `compatible` range now. A range is a promise that nobody tested. The wait has a simple cure: promote the neighbour first. The owner decides again when a real wait costs time often.

Open risk: two services that each need the other in Production first would wait for each other. The lab has no such pair, because a release records the state of Test at the time of its suite. The way out is a `compatible` range for one of the two, or one coordinated approval of both releases.

### Why this is cheaper than promoting all services as one set

The alternative is to promote the four versions together, as one unit: one manifest, one approval, all four deployments in one run. That has real benefits. The set that passed is the set that deploys, with no gap.
It also has costs:

- Every change to one service now needs a release of all four. A small fix in web waits for the slowest service, and a failure of one deployment holds back the others.
- The services lose their own pace. The reason for several repositories (a team ships when it is ready) is gone.
- The unit grows with each service. A fifth service joins every release.
- One approval in Production covers four deployments. A reviewer reads less about each change.

The comparison costs one SSM call (a few seconds) in the job that deploys, and no new job, no new approval and no shared release. The price is that the guarantee is weaker. The check shows that the neighbours are not older than the tested ones. It does not run the whole set in Production.
For a lab with four small services, the comparison is the cheaper choice. A team with many tightly coupled services would choose the unit.

## Contract tests

A contract test catches this fault: service A passes its own tests, but it breaks a service that calls it.
The check runs on every pull request, before Test. It compares two small files. It needs no deployment and no AWS access.

The tested set (see above) catches a different fault. It compares version numbers when the services promote on their own.
The contract check compares what a provider promises with what its consumers read.

### The words

| Word | Meaning |
| --- | --- |
| Provider | A service that other services call. Core is a provider for catalogue and account. Catalogue and account are providers for web. |
| Consumer | A service that calls a provider. |
| Contract | The file `contract.json` of a provider. It says what the provider promises in its answers and what it needs in a request. |
| Expectations | The file `expectations.json` of a consumer. It says which fields of a provider the consumer really reads. |
| Production marker | The release asset `deployed-production.json`. It says "this release runs in Production now". |

A service can be a provider and a consumer. Catalogue is both, so it has both files.

### The two files

Both files are in the root of the service repository, next to `pipeline.json`. A person writes them and changes them by hand.
The examples are in `actions/contract/fixtures/`.

A provider keeps `contract.json`:

```json
{
  "service": "core",
  "consumers": ["catalogue", "account"],
  "endpoints": {
    "GET /items": {
      "request": { "required": [], "optional": ["query:limit"] },
      "responses": {
        "200": {
          "type": "object",
          "required": ["service", "version", "items"],
          "properties": {
            "service": { "type": "string" },
            "version": { "type": "string" },
            "items": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["id", "name"],
                "properties": { "id": { "type": "string" }, "name": { "type": "string" } }
              }
            }
          }
        }
      }
    }
  }
}
```

- `service` must be the `service` of `pipeline.json`.
- `consumers` is optional. It lists the services that call this provider. The check downloads their expectations.
- The key of an endpoint is `"<METHOD> <path>"`, for example `GET /items`.
- `request.required` and `request.optional` list the inputs of a request. An input is `query:<name>`, `header:<name>`, `body:<name>` or `path:<name>`. The authorisation (SigV4) is not listed.
- `responses` maps a status code to a schema. A status code has 3 digits. The lab lists the success answer (200). A schema for an error answer is optional.
- `description` is allowed in the file, in an endpoint and in a schema. No check reads it.

A consumer keeps `expectations.json`:

```json
{
  "service": "catalogue",
  "expects": {
    "core": {
      "GET /items": {
        "sends": [],
        "responses": {
          "200": {
            "type": "object",
            "required": ["version", "items"],
            "properties": {
              "version": { "type": "string" },
              "items": {
                "type": "array",
                "items": { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } }
              }
            }
          }
        }
      }
    }
  }
}
```

- `expects.<provider>.<endpoint>.sends` lists the request inputs that the consumer sends.
- A schema in `responses` holds only what the consumer reads. `required` lists the fields that must be there.
- A field in `properties` but not in `required` is read when it is there. The consumer copes when it is missing.
- A consumer may list an endpoint without `responses`. Then it only needs the endpoint to exist.

#### The schema subset

A schema is a JSON object. It has only these keywords. Any other keyword is an error with the text `unsupported keyword`. So nobody thinks that the check reads it.

| Keyword | Meaning |
| --- | --- |
| `type` | Required. One of `string`, `number`, `integer`, `boolean`, `object`, `array`. |
| `properties` | For `object`. A map from a name to a schema. |
| `required` | For `object`. A list of names. Each name must be a key of `properties`. |
| `items` | For `array`. One schema. |
| `description` | Text. No check reads it. |

An object may have more properties than the schema lists. The contract is open.
An `integer` is a valid value where a schema says `number`.

The check also refuses these:

- an unknown key in the file,
- a request input that does not match the pattern,
- a status code without 3 digits,
- a `service` that is not the `service` of `pipeline.json`.

Each error names the file and the place in the file, for example `contract.json: $.endpoints["GET /items"].responses["200"].properties.items.items.properties.id.enum`.
To check one file on your laptop, run `node actions/contract/cli.mjs validate contract.json`. The command looks for a `pipeline.json` next to the file.

### The release assets

Each GitHub release of a service holds these files next to `cdk-out-<tag>.zip`:

| Asset | What it is |
| --- | --- |
| `contract.json` and `expectations.json` | A copy of the file at the released commit. The job `build` attaches a file if the repository has it. |
| `tested-with.json` | The tested set (see "The tested set"). |
| `deployed-production.json` | The production marker. A job writes it after a successful deployment to Production. |

The marker holds the service, the version, the tag, the environment, the commit, the URL of the run and the time.
The check does not read the content. It reads the name of the asset and the time of its upload.

### How the job finds the version in Production

The job needs the contract and the expectations of the version that runs in Production now. A pull request compares with that version, and not with `main`.
`main` holds changes that no person has released. Production is where a break hurts.

1. The job lists the releases of the repository with `gh api repos/<owner>/<repository>/releases`. It reads all pages. It skips draft releases.
2. It keeps the releases that have the asset `deployed-production.json`.
3. It picks the release whose marker has the newest `updated_at`.
4. It downloads `contract.json` or `expectations.json` of that release with `gh api -H 'Accept: application/octet-stream' repos/<owner>/<repository>/releases/assets/<id>`.

The newest marker wins, and not the newest version. A redeploy to Production uploads the marker again, with `--clobber`, on the release that it deploys. So after a rollback the older release has the newest marker.
Version `0.9.0` is newer than `0.8.0`. If a rollback puts `0.8.0` in Production again, the check compares with `0.8.0`.

| Release | Marker uploaded | Production runs |
| --- | --- | --- |
| `v0.8.0` | 10:00 | `v0.8.0` |
| `v0.9.0` | 12:00 | `v0.9.0` (the newest marker) |
| `v0.8.0` after a redeploy | 14:00 | `v0.8.0` (the newest marker again) |

The lab considered four other ways to find the version in Production:

| Other way | Why the lab did not use it |
| --- | --- |
| The latest release | A release is the latest before it reaches Production. It can wait for the reviewer or fail its smoke check. A rollback goes to an older release. |
| The SSM parameter `/lab/<service>/version` | A pull request job has no AWS access, on purpose. The parameter gives a version, but no contract. |
| A git tag such as `production` that moves | Moving a tag needs a force-push. The tag keeps no history. |
| The deployment record of the GitHub environment | The record names the commit of the run. A redeploy runs from `main`, so it names the wrong commit. |

The marker is a plain file next to the files that the check needs. It keeps the history, because each release keeps its own copy. A reader can see it in the release page.

### The production marker

The job `record-production` of `release.yml` writes the marker. It runs after `deploy-production` succeeded. It needs no AWS access and no approval.
The job calls the action `actions/record-production`. The action writes the file and runs `gh release upload <tag> deployed-production.json --clobber`. The job has the permission `contents: write` and no other.
The job `record` of `redeploy.yml` does the same after a successful redeploy to Production. It writes the marker on the release of the version that it deployed.

The file holds the facts of the deployment:

```json
{"service":"core","version":"0.8.0","tag":"v0.8.0","environment":"production","commit":"<sha>","run":"<run url>","at":"<ISO time>"}
```

The marker has limits:

- **A failed smoke check leaves no marker.** The smoke check is a step of the job `deploy-production`. If it fails, the job fails and `record-production` does not run. The new version is live then, but the release has no marker. The check still compares with the release that has the newest marker, and so it is one version behind. A later successful release closes the gap.
- **A failed smoke check in a redeploy leaves no marker either.** The job `record` of `redeploy.yml` runs only if the job `redeploy` passed.
- **A late re-run moves the marker back.** The time of the upload counts. If a person re-runs `record-production` of an old release after a newer release reached Production, the old release has the newest marker. Re-run the job only right after the deployment.
- **The marker says "the deployment job passed".** It does not say "the service works". The smoke check covers that.
- **Old releases have no marker.** Until a release with a marker reaches Production, the check writes notices and compares nothing.

### The rules for a provider: B1 to B6

The job compares the contract in the pull request (new) with the contract of the release in Production (old). It walks each endpoint of the old contract.

| Id | Breaking when | The message names |
| --- | --- | --- |
| B1 | A property of the old contract is not in the new one. This holds at any depth, also for the items of an array. | The field path, for example `items[].name`. |
| B2 | The `type` of a property changed. | The field path, the old type and the new type. |
| B3 | A name in `required` of the old contract is not in `required` of the new one. The field became optional. | The field path. |
| B4 | A status code of the old contract has no schema in the new one. | The status code. |
| B5 | An endpoint of the old contract is not in the new one. | The endpoint. |
| B6 | The new contract requires a request input that the old one did not require. The input is new, or it was optional. | The input. |

One type change is allowed: `number` to `integer`. The new type is narrower, so a reader still copes. The change `integer` to `number` is breaking.

These changes pass:

- a new property, also a new required one,
- a new endpoint,
- a new status code,
- a new optional request input, and an optional input that stays optional,
- a field that was optional and is required now,
- the change `number` to `integer`.

The path of a field uses `.` for an object and `[]` for the items of an array. The path `items[].name` means the field `name` in each item of `items`. The path `grid[][].cell` goes through an array of arrays.

### The rules for a consumer: X1 to X5

The job verifies a contract against the expectations of a consumer. It does this in two places:

- A **provider** pull request verifies the new contract against the expectations of each consumer in `consumers`. It uses the expectations from the release of the consumer that runs in Production.
- A **consumer** pull request verifies the expectations in the pull request against the contract of each provider in `expects`. It uses the contract from the release of the provider that runs in Production.

| Id | Violation | The message names |
| --- | --- | --- |
| X1 | The contract has no such endpoint, or it has no schema for an expected status code. | The endpoint and the status code. |
| X2 | The consumer lists a property in `properties` and in `required`, and the contract does not have it. | The field path. |
| X3 | A property that the consumer lists is in the contract with another `type`. This holds also for an optional field. | The field path, the expected type and the contract type. |
| X4 | The consumer lists a field in `required`, but the contract does not list it in `required`. | The field path. |
| X5 | The contract requires a request input that the consumer does not send. | The input. |

If the consumer lists a property but not in `required`, a missing property is fine (X2 does not apply). The check walks `properties` and `items` to any depth. An `integer` in the contract satisfies a `number` in the expectations.

The two directions give an order for a new field. The provider releases the field first. Then the consumer lists it in `required`, because the production contract has it now. A consumer pull request that needs a field which Production does not have yet fails with X2.

### The label

The label `breaking-change-approved` on a pull request lets B1 to B6 pass. It says "a person knows that this change breaks a contract, and has a plan".
The summary then says "Approved by label" and lists what the label approved.

The job reads the labels with the API at the time it runs, like the stateful change guard. A re-run sees a new label. The caller does not listen to label events.
The label has an exact spelling. It must exist in the repository. A person with triage rights can add it.

The label never lets X1 to X5 pass. An X rule says "a consumer that runs in Production reads this, and it will break now". No approval of the provider fixes that. Release the consumer first.

### What the pull request job does

The job `contracts` of `pr.yml` calls `actions/contract-check`. The caller must check out the repository first. The command is `node actions/contract/cli.mjs pr-check`.

1. No `contract.json` and no `expectations.json`: the job writes a notice and passes.
2. The job parses each file that exists. A format error fails the job. The message names the file and the place in the file.
3. If `contract.json` exists:
   1. The job finds the release of this repository that runs in Production. With no marker, it writes the notice "no release is recorded in Production yet" and skips this part. A release with a marker but without a `contract.json` asset gives a notice too.
   2. It compares with B1 to B6. A violation fails, unless the pull request has the label.
   3. For each service in `consumers`, it finds the release in Production and downloads `expectations.json`. With no marker or no file it writes a notice and goes on. Otherwise it runs X1 to X5. A violation fails.
4. If `expectations.json` exists: for each provider in `expects`, it downloads `contract.json` of the release in Production and runs X1 to X5. With no marker or no file it writes a notice and goes on.
5. The job writes a table to the job summary and one `::error` line for each violation. A line has the rule, the field path and a hint.

This is how the job prints a breaking change (B1) and a consumer that expects a field (X2):

```
::error title=Breaking change B1 (field removed)::GET /items 200: the field items[].name is in the production contract (core 0.8.0) but not in this pull request. A consumer may read it. Move the consumers to the new field and release them first. Then add the label breaking-change-approved to this pull request and run this job again.
::error title=Consumer expects a field (X2)::catalogue 0.7.1 (in Production) expects GET /items 200: items[].name. The contract in this pull request does not have it. Release catalogue without that field first.
```

These cases do not fail the job:

| Case | What the job does |
| --- | --- |
| The repository has no contract file | A notice. |
| No release of the repository, a consumer or a provider has a marker | A notice. The check skips that part. |
| The release in Production has no `contract.json` or no `expectations.json` | A notice. The consumer "has published nothing". |
| The file of a released version is not valid, for example a version from before a stricter rule | A warning. A pull request cannot fix a released file, so the check skips it. |

The job fails when `gh` cannot read a release, a file or the labels. The message says to run the job again. A check that passes when it could not look would give false trust.

A pull request from a fork gets a read-only token. The token can read public releases and labels, so the job works for a fork.

#### Text from the files is untrusted

A pull request writes the files. A field name can hold a line break and the text `::error::`. GitHub reads a line that starts with `::` as a workflow command.
Before the job prints a text from a file, it cleans the text. It replaces control characters with a space and `::` with `:`. It cuts the text at 200 characters and escapes `%`.
A text for the job summary also gets a backslash before the characters that make markup.
The names of services are checked with a strict pattern before they go into the name of a repository.

### What the check does not do

- It compares two files. It does not prove that a file is true. If the provider returns a field that its `contract.json` does not list, nothing notices.
- It checks the shape of an answer: names, types and "must be present". It does not check values, the meaning of a field, the order of calls or the time that a call takes.
- It does not check a consumer that is not in `consumers`, or a consumer that has not published `expectations.json` yet.
- It does not check authorisation, events, queues or the data in a table.
- It compares with Production only. A change that Test or Staging already runs is not the baseline.
- It does not stop a removed request input. A provider that stops to accept an input does not break a consumer that still sends it.
- It does not run a request. The tested set, the end-to-end suite and the smoke check do that.

### The trade-offs

- **Files by hand.** A person must keep `contract.json` and `expectations.json` true. The gain is a check that is cheap, offline and easy to read in a pull request. A test in the service repository can close the gap. It validates a real answer of the handler against the contract, or it makes the expectations from the code that reads the answer.
- **Two files, not one.** The provider says what it promises. The consumer says what it reads. A provider may add fields freely, and a consumer lists only the fields it needs. The cost is a second file in each consumer.
- **Production as the baseline.** The check protects what runs now. The price is that a change can pass while an unreleased consumer in Test still reads the old field. The tested set and the end-to-end suite cover that case.
- **A label for B, no label for X.** A provider owner can accept a break of a contract that nobody uses. The owner cannot accept the break of a consumer that reads the field now.
- **The newest marker.** The rule is simple and it follows rollbacks. It trusts the upload time of the asset. A failed smoke check in Production leaves no marker. The version is live, but the check does not know it.
- **No contract tool such as Pact.** A tool like that brings a library to each repository and, in most set-ups, a broker service. Two small files and `gh` give the main gain for four services.

### What a service repository must add

1. A provider adds `contract.json`. A consumer adds `expectations.json`. A service that is both adds both. The file `pipeline.json` must exist already.
2. The label `breaking-change-approved` in the repository.
3. The required check `pr / contracts` in the branch protection or the ruleset of `main`.
4. A release after the files exist. The release attaches the files, and the first deployment to Production writes the marker. Until then the check writes notices.
5. Optional: a unit test that validates a real answer of the handler against `contract.json`.

The caller `pr.yml` needs no change. It gives `pull-requests: write` for the diff comment already, and the job `contracts` asks only for `contents: read` and `pull-requests: read`.

### What is proven

The unit tests in `actions/contract` cover these cases:

- each rule B1 to B6 and X1 to X5,
- the changes that must pass, and nested arrays,
- the label for B, and no label for X,
- no marker, a marker without an asset, and a consumer without expectations,
- a format error, an unsupported keyword and a hostile field name,
- two releases with markers.

Run them with `node --test actions/contract/lib.test.mjs actions/contract/cli.test.mjs`.

The lab ran `findProductionRelease` and `fetchAsset` for real on 2026-10-08 against the public repositories lab-svc-core, lab-svc-catalogue and lab-web. The test used the asset `tested-with.json` in place of the marker, because no release had a marker yet.
The listing found the release with the newest asset. The download with `gh api -H 'Accept: application/octet-stream'` gave the exact text of the file. A repository that does not exist gave `gh: Not Found (HTTP 404)`.
`gh release download <tag> --pattern <name> --output -` gave the same text. The lab uses `gh api` with the asset id, because the id comes from the listing and needs no pattern.

## Smoke checks in Staging and Production

After the deployment, `deploy-staging` and `deploy-production` run the smoke subset of the E2E suite against their own environment. The tests with the tag `@smoke` in [lab-e2e](https://github.com/jross24/lab-e2e) form the subset. They only read:

- The page of web loads and shows no error block.
- Each public API answers with the documented shape.
- The versions on the page equal the versions that the services report.
- **The released service reports the version of the release.** The job passes the service and the version to the suite.

The smoke subset runs as steps of the deploy job, through the action `actions/suite` of lab-e2e. It is not a separate job, for two reasons:

- A second job in the `production` environment needs a second approval of the reviewer. The lab checked this: GitHub asks again for each job that names a protected environment.
- The deploy job holds the concurrency group of its environment. No other release of the repository can deploy between the deployment and the check. A separate job would let the next release change the service first, and the check would then see another version.

A failed smoke check in Staging fails `deploy-staging`. `deploy-production` needs `deploy-staging`, so the promotion stops.

### A failed smoke check in Production

The canary and its alarms watch the first minutes of the release. The smoke check is the last line, after the canary has moved all the traffic. A failure at that point means that the new version carries all the traffic and fails a check.

The job `deploy-production` then fails, so the run is red. This is the loud part. The last step, `propose-rollback`, does three things:

1. It writes an error annotation and a summary with the way back, including the exact command.
2. If Production ran an earlier version of the service, it starts the workflow `redeploy.yml` of the service repository for that version. It does not start the workflow when that version is below the rollback floor. The run waits for the production reviewer, like every deployment to Production.
3. It never changes Production by itself.

The lab chose this over an automatic rollback for these reasons:

- A smoke check can fail for a reason that is not a fault of the release, for example a network error of the runner. An automatic rollback of a good release is a second incident, and a rollback takes a canary of 5 minutes.
- The redeploy waits for a person, so the person decides with the facts of the summary. A false alarm costs one click: cancel the run.
- A rollback needs the stored cloud assembly of the earlier release. The redeploy workflow already does this, with the same checks and the same canary.
- The redeploy run holds the concurrency group `deploy-production`. So no newer release deploys to Production before the person has decided.

If Production had no earlier version, or the earlier version is the same, there is nothing to go back to. The summary says so, and the way forward is a new release.

Before the step starts the redeploy, it reads the rollback floor from `/lab/<service>/min-rollback-version`. The deploy job still has the AWS login of the deployment. The new release may have raised the floor.

If the earlier version is below the floor, the step does not start the redeploy. It writes a warning with the text of the refusal. The summary says to fix forward.

If the step cannot read the floor, it goes on as before and writes a notice. This happens when the parameter is missing, when access fails, or when the value is not a version. The step still never fails.

The redeploy workflow reads the floor again. So it refuses a version below the floor, also when a person starts it by hand.
Rollback by `redeploy.yml` works for releases that have a stored assembly. The README of each service says which old versions cannot be redeployed.

## The five kinds of test

The pipeline runs five kinds of test. Each kind catches a fault that the others miss. The cheap kinds run early, so a fault does not wait for Test.

| Kind | What it catches | When it runs |
| --- | --- | --- |
| Unit test | A logic error in one function of one repository. | On a pull request, and in the job `build` of a release. |
| Contract test | A provider that breaks its consumers, although the provider passes its own tests. It compares files and calls nothing. See "Contract tests". | On a pull request, with no deployment. |
| End-to-end suite | A break in the wiring that no file shows: the URLs, the permissions and the real data. See "The end-to-end gate". | In Test, after the deployment. |
| Tested-set check | Version drift, when the services promote on their own. It compares version numbers of the neighbours in an environment with the set that passed in Test. See "The tested set". | Before the deployment to Staging and to Production. |
| Smoke check | A deployment that succeeded, but the service does not answer. It sends a few read-only requests to the live environment. See "Smoke checks in Staging and Production". | After the deployment to Staging and to Production. |

The contract test and the tested-set check look similar, but they check different things.
The contract test asks: "Does the new provider still keep the promises that its consumers use?" It answers from files, before any deployment.
The tested-set check asks: "Do the neighbours in this environment have at least the versions that passed together in Test?"
It answers from version numbers, right before a deployment.

## The fault drill

Two proofs need a suite that fails on purpose: a failed suite stops the release and still releases the lock, and a failed smoke check stops the promotion. The drill makes that possible without a broken `main`.
The owner of a service repository sets the repository variable `E2E_FAULT_DRILL` to one token: `full-test`, `smoke-staging` or `smoke-production` (the full list is in the README of lab-e2e).
The next release fails in the run that the token names. Remove the variable to end the drill. The release workflow passes `vars.E2E_FAULT_DRILL` of the caller repository to the suite.
The redeploy workflow passes the variable too. A token such as `smoke-production` makes the smoke check of the redeploy that `propose-rollback` starts fail as well. Remove the variable before you approve that rollback.

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

## Releases in order

Four things decide how releases of one repository follow each other: the concurrency groups, the Test lock, the check "no step back", and the job `supersede`.

### The old design and its two effects

The first design put one `concurrency` group in the caller workflow of each service: `group: release`, `cancel-in-progress: false`. It covered the whole run. Two effects hurt (issue 14):

- A release that waits for the production reviewer is still in progress. The next merge to `main` does not reach Test or Staging until someone approves or rejects the waiting release.
- GitHub keeps one waiting run in a group. A third release cancels the second one.

The opposite design, no group at all, is worse. Two releases could wait for Production at the same time, and a late approval of the older one would move Production back.

### The design now

The caller has no `concurrency` group. The jobs that touch one environment have a group of their own, inside `release.yml`. This works in a called workflow: the lab tested job-level groups in a reusable workflow, and GitHub accepts them.

| Group | Job | What it does |
| --- | --- | --- |
| `release-version` | `version` | Two versions are made one after the other, so two runs cannot read the same tags. |
| `release-test-queue` | `lock-test` | One release of the repository waits for the Test lock at a time. |
| `deploy-staging` | `deploy-staging` | One deployment to Staging at a time. The smoke check is inside the job. |
| `deploy-production` | `deploy-production` | One deployment to Production at a time. A job that waits for the reviewer holds the group. |

All groups use `cancel-in-progress: false`. GitHub never stops a deployment that is running.
A group belongs to one repository, so the four services do not wait for each other here. The Test lock does that.

`redeploy.yml` uses the groups `deploy-<environment>`. So a redeploy and a release of the same repository cannot deploy to one environment at the same time.

What GitHub does with a group (checked in a real experiment on 2026-10-08, and in the real runs below):

- A job that waits for the reviewer **holds** its group. The next release is `pending` at the same job. The reviewer of the next release is not asked yet.
- A group keeps one `pending` job. A third release replaces the second one, and the run of the second release ends as `cancelled`. The third contains the changes of the second.
- `queue: max` keeps up to 100 jobs, in first-in-first-out order, and cancels none of them. The lab tested it. It is not used here. Every release would then need its own approval in Production, also the old ones that the next release contains. The default group with one pending job fits better: the newest change wins.
- A second job in the same run that names a protected environment asks for approval again. This is why the smoke check is a step in the deploy job.

### The older approval is superseded

A release that waits for the reviewer holds the group `deploy-production`. When the next release reaches the end of Staging, its job `supersede` looks for older runs of the same workflow that:

- have the status `waiting` (nobody approved them, so they do not deploy),
- are older than this run,
- wait in a job whose name ends with `deploy-production`.

It cancels them with `gh run cancel`. The job needs the permission `actions: write`, and the caller must give it. The new release contains the changes of the old one, so the old approval has no use.
The reviewer then sees one waiting release, the newest. The job checks the status of the run again right before the cancel. A run that the reviewer approved in the meantime is not cancelled.
The job never fails the release. If the cancel does not work, the guard "no step back" and the group still keep the order, and the old run waits first.

If the old release was already approved and deploys, nothing is cancelled. The next release waits in the group until the deployment ends. Then it asks for its own approval.

### "Production receives releases in order"

Four rules make this true:

1. One deployment to Production at a time (the group).
2. A waiting approval holds the group, so a newer release cannot deploy before it. It either waits behind it, or it cancels the older run first (`supersede`).
3. A release that is older than Production does not deploy (the check "no step back"). A group orders the jobs by the time they arrive, and a release with a slower build can arrive later than a newer one. The check catches this case, and also a late approval. The late release fails with `Release superseded`.
4. A third release replaces a second one that waits for the group. The changes are not lost, because the newest release contains them.

The `redeploy` workflow is the exception on purpose. It can put an older version into Production, because a rollback must be possible. It uses the same group. To roll back while a release waits for the reviewer, reject or cancel the waiting release first. Otherwise the redeploy waits behind it.
The group keeps one pending job, so a pending redeploy and a pending release can replace each other. A redeploy that the job `propose-rollback` starts can cancel the pending job of a newer release. Re-run that release after you have decided about the rollback.
The job `supersede` sees only runs with the status `waiting`. An older run that still waits for the group is not cancelled by it. The group replaces it when a third release arrives.

### The migration

The rules need the caller to give `actions: write` and to have no workflow-level group. A caller with `permissions` that lack `actions: write` makes the run fail at the start, because a called workflow cannot ask for more than its caller gives. Change the callers first, then change this repository.

The same lesson holds for `redeploy.yml`. Its job `record` asks for `contents: write`. The four callers gave only `contents: read` and `id-token: write` to `redeploy.yml`.
A called workflow that asks for more than its caller gives fails at the start, also when the job that asks for it is skipped. Every redeploy would fail, and so would a rollback.
So the change of `redeploy.yml` waited until the four callers gave `contents: write`.

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
`pr.yml` has two more jobs: `diff` (see "The cdk diff comment") and `contracts` (see "Contract tests").
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

### Accepted advisories: a short list with dates

**Why the list exists.** The dependency check judges only what a pull request adds. A new repository has an empty base, so every dependency counts as new.
Then the check fails on a finding that nobody can fix. This happened to the first pull request of `lab-flags`. `aws-cdk-lib` 2.272.0, the newest release, bundles `brace-expansion` 5.0.9.
That copy has two high advisories, GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7, and no patched `aws-cdk-lib` exists ([lab-platform#15](https://github.com/jross24/lab-platform/issues/15)).
A new repository could not merge its first pull request until someone fixed an upstream package.

**What the list is.** The file `accepted-advisories.json` in the root of this repository holds the advisories that the lab accepts for now. Each entry has five fields, and all five are required:

- `id`: the GitHub advisory id, for example `GHSA-6j4f-fj2g-mc7p`.
- `package`: the package that the advisory is about.
- `reason`: one line that says why nobody can fix it now.
- `issue`: the issue that tracks the fix, written as `owner/repo#number`.
- `expires`: the last day that the entry applies, written as `YYYY-MM-DD`.

**How the job uses it.** The job `dependencies` runs in the service repository, not in this one. So it checks out this repository into `.lab-tools` at `tools-ref`, the same input that the job `diff` uses.
The script `actions/accepted-advisories/cli.mjs allowed` reads the file. It passes the ids that have not expired to the input `allow-ghsas` of the action. The action then skips these advisories and no others.
A new advisory still fails the job. The list does not come from the service repository, so a pull request cannot add an entry to its own check.

**Why each entry has a date.** An exception without an end date stays for ever, and people forget it. The date forces a new decision.
An entry applies up to and including the day of `expires`. The day after, the script leaves it out. The check `pr / dependencies` fails again on that advisory, and a warning names the entry.
The `ci` workflow of this repository also fails, with an error that names the entry. It fails the same way when an entry lacks a field or has a wrong value.
The date may be at most 90 days ahead, so an entry cannot last for years.

**Add an entry.** Open a pull request to this repository and add one object to `accepted-advisories.json`. Check first that no fix exists: no patched version of the package that carries the copy.
Write the reason in one line. Open an issue that tracks the fix and put its name in `issue`. Choose the nearest date at which someone will look again.
Run `node actions/accepted-advisories/cli.mjs check` to check the file. The unit tests of the script pass the date to the code, so they do not depend on the clock.

**An exception is a decision, not a way to silence the check.** The issue in `issue` has an owner. The owner decides, before the date, to fix the dependency and remove the entry, or to renew the entry with a new date and a new reason.
Nobody renews an entry just to make a red check green. The entry applies to the advisory in every repository that calls `pr.yml`. It does not hide the alert in Dependabot, and it does not change `fail-on-severity`.

To test a change of the list before it reaches `main`, follow "Test a change of `pr.yml` before it reaches `main`" below and also pass `tools-ref: <your branch>`. Then the job reads the list of your branch.

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
It runs the tests of the scripts: next-version, lock, preflight, supersede, propose-rollback, install-tool, changed-paths and secret-scan. It also runs the tests of the Node scripts for the diff comment, the preview, the contract check and the accepted advisories. The new tests need `jq`, which the runner image has. It also runs `shellcheck` and `actionlint`.
The step "check the list of accepted advisories" fails when an entry of `accepted-advisories.json` is past its date or lacks a field.

`actionlint` is not optional. It checks every workflow file in `.github/workflows/`, and it runs `shellcheck` on the `run:` scripts.
Any finding fails the job `check`. `shellcheck` on the scripts still runs only if the runner image has it, and the image has it today.
See [lab-platform#22](https://github.com/jross24/lab-platform/issues/22).
