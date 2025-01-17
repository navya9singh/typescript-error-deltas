import exercise = require("./utils/exerciseServerConstants");
import ge = require("./utils/getTscErrors");
import pu = require("./utils/packageUtils");
import git = require("./utils/gitUtils");
import { execAsync, SpawnResult, spawnWithTimeoutAsync } from "./utils/execUtils";
import ip = require("./utils/installPackages");
import ut = require("./utils/userTestUtils");
import fs = require("fs");
import path = require("path");
import mdEscape = require("markdown-escape");
import randomSeed = require("random-seed");

interface Params {
    /**
     * Store test repos on a tmpfs.
     * Basically, the only reason not to do this would be lack of `sudo`.
     */
    tmpfs: boolean;
    /**
     * True to produce more verbose output (e.g. to help diagnose resource exhaustion issues).
     * Default is false to save time and space.
     */
    diagnosticOutput?: boolean;
    /**
     * True to allow errors in the baseline build and report as missing any not reported by the candidate build.
     */
    buildWithNewWhenOldFails: boolean;
    /**
     * Path to a JSON file containing an array of Repo objects to be processed.
     */
    repoListPath: string;
    /**
     * How many workers are processing the same repo list.
     */
    workerCount: number;
    /**
     * 1-indexed position of the current worker.
     */
    workerNumber: number;
    /**
     * Name of a directory in which a summary file should be written for each repo to be included in the output
     * (i.e. those with interesting failures).
     * Sneakiness: not a path since referred to in output as component of AzDO artifact name
     */
    resultDirName: string;
    /**
     * Which TypeScript entrypoint (tsc or tsserver) to test.
     */
    entrypoint: TsEntrypoint;
    /**
     * Used to make runs repeatable (e.g. when confirming that a PR no longer introduces failures).
     * Pass undefined to have a seed generated.
     */
    prngSeed: string | undefined;
}
export interface GitParams extends Params {
    testType: "github";
    oldTsNpmVersion: string;
    newTsNpmVersion: string;
}
export interface UserParams extends Params {
    testType: "user";
    oldTsRepoUrl: string;
    oldHeadRef: string;
    prNumber: number;
}

export type TsEntrypoint = "tsc" | "tsserver";

const processCwd = process.cwd();
const packageTimeout = 10 * 60 * 1000;
const executionTimeout = 10 * 60 * 1000;

const prng = randomSeed.create();

export type RepoStatus =
    | "Unknown failure"
    | "Git clone failed"
    | "Package install failed"
    | "Project-graph error in old TS"
    | "Too many errors in old TS"
    | "Language service disabled in new TS"
    | "Detected interesting changes"
    | "Detected no interesting changes"
    ;

interface RepoResult {
    readonly status: RepoStatus;
    readonly summary?: string;
    readonly replayScriptPath?: string;
}

function logStepTime(diagnosticOutput: boolean, repo: git.Repo, step: string, start: number): void {
    if (diagnosticOutput) {
        const end = performance.now();
        console.log(`PERF { "repo": "${repo.url ?? repo.name}", "step": "${step}", "time": ${Math.round(end - start)} }`);
    }
}

async function cloneRepo(
    repo: git.Repo,
    userTestsDir: string,
    downloadDir: string,
    diagnosticOutput: boolean): Promise<boolean> {
    const cloneStart = performance.now();
    try {
        const isUserTestRepo = !repo.url;
        if (isUserTestRepo) {
            await ut.copyUserRepo(downloadDir, userTestsDir, repo);
        }
        else {
            try {
                console.log("Cloning if absent");
                await git.cloneRepoIfNecessary(downloadDir, repo);
            }
            catch (err) {
                reportError(err, "Error cloning " + repo.url);
                return false;
            }
        }

        return true;
    } finally {
        logStepTime(diagnosticOutput, repo, "clone", cloneStart);
    }
}

async function getMonorepoPackages(repoDir: string): Promise<readonly string[] | undefined> {
    try {
        return await pu.getMonorepoOrder(repoDir);
    }
    catch (e) {
        reportError(e, `Error identifying monorepo packages for ${repoDir} - treating as separate packages`);
        return undefined;
    }
}

async function installPackagesAndGetCommands(
    repo: git.Repo,
    downloadDir: string,
    repoDir: string,
    monorepoPackages: readonly string[],
    cleanOnFailure: boolean,
    diagnosticOutput: boolean): Promise<ip.InstallCommand[] | undefined> {
    const packageInstallStart = performance.now();
    try {
        console.log("Installing packages if absent");
        const isUserTestRepo = !repo.url;
        const commands = await ip.installPackages(
            repoDir,
                /*ignoreScripts*/ true,
                /*quietOutput*/ !diagnosticOutput,
                /*recursiveSearch*/ !isUserTestRepo,
                /*monorepoPackages*/ monorepoPackages,
            repo.types);
        await installPackages(repoDir, commands, packageTimeout);
        return commands;
    }
    catch (err) {
        reportError(err, `Error installing packages for ${repo.name}`);
        if (/ENOSPC/.test(String(err))) {
            await reportResourceUsage(downloadDir);
        }

        if (cleanOnFailure) {
            // It's perfectly reasonable to run the server against a repo with only some packages installed,
            // but making that mode repro-able could be complicated, so remove all packages for simplicity.
            console.log("Removing installed packages");
            await execAsync(repoDir, "git clean -xdff");
            return [];
        }
        else {
            return undefined;
        }
    }
    finally {
        logStepTime(diagnosticOutput, repo, "package install", packageInstallStart);
    }
}

async function getTsServerRepoResult(
    repo: git.Repo,
    userTestsDir: string,
    oldTsServerPath: string,
    newTsServerPath: string,
    downloadDir: string,
    replayScriptArtifactPath: string,
    diagnosticOutput: boolean): Promise<RepoResult> {

    if (!await cloneRepo(repo, userTestsDir, downloadDir, diagnosticOutput)) {
        return { status: "Git clone failed" };
    }

    const repoDir = path.join(downloadDir, repo.name);
    const monorepoPackages = await getMonorepoPackages(repoDir);

    // Presumably, people occasionally browse repos without installing the packages first
    const installCommands = (prng.random() > 0.2) && monorepoPackages
        ? (await installPackagesAndGetCommands(repo, downloadDir, repoDir, monorepoPackages, /*cleanOnFailure*/ true, diagnosticOutput))!
        : [];

    const isUserTestRepo = !repo.url;

    const replayScriptName = path.basename(replayScriptArtifactPath);
    const replayScriptPath = path.join(downloadDir, replayScriptName);

    const lsStart = performance.now();
    try {
        console.log(`Testing with ${newTsServerPath} (new)`);
        const newSpawnResult = await spawnWithTimeoutAsync(repoDir, process.argv[0], [path.join(__dirname, "utils", "exerciseServer.js"), repoDir, replayScriptPath, newTsServerPath, diagnosticOutput.toString(), prng.string(10)], executionTimeout);
        if (!newSpawnResult) {
            // CONSIDER: It might be interesting to treat timeouts as failures, but they'd be harder to baseline and more likely to have flaky repros
            console.log(`New server timed out after ${executionTimeout} ms`);
            return { status: "Unknown failure" };
        }

        if (diagnosticOutput) {
            console.log("Raw spawn results (new):");
            dumpSpawnResult(newSpawnResult);
        }

        switch (newSpawnResult.code) {
            case 0:
            case null:
                if (newSpawnResult.signal !== null) {
                    console.log(`Exited with signal ${newSpawnResult.signal}`);
                    return { status: "Unknown failure" };
                }

                console.log("No issues found");
                return { status: "Detected no interesting changes" };
            case exercise.EXIT_LANGUAGE_SERVICE_DISABLED:
                console.log("Skipping since language service was disabled");
                return { status: "Language service disabled in new TS" };
            case exercise.EXIT_SERVER_CRASH:
            case exercise.EXIT_SERVER_ERROR:
            case exercise.EXIT_SERVER_EXIT_FAILED:
                // These deserve to be mentioned in the summary
                break;
            case exercise.EXIT_BAD_ARGS:
            case exercise.EXIT_UNHANDLED_EXCEPTION:
            default:
                console.log(`Exited with code ${newSpawnResult.code}`);
                // Don't duplicate if printed above
                if (!diagnosticOutput) {
                    dumpSpawnResult(newSpawnResult);
                }
                return { status: "Unknown failure" };
        }

        console.log(`Issue found in ${newTsServerPath} (new):`);
        console.log(insetLines(prettyPrintServerHarnessOutput(newSpawnResult.stdout, /*filter*/ false)));

        console.log(`Testing with ${oldTsServerPath} (old)`);
        const oldSpawnResult = await spawnWithTimeoutAsync(repoDir, process.argv[0], [path.join(__dirname, "..", "node_modules", "@typescript", "server-replay", "replay.js"), repoDir, replayScriptPath, oldTsServerPath, "-u"], executionTimeout);

        if (diagnosticOutput && oldSpawnResult) {
            console.log("Raw spawn results (old):");
            dumpSpawnResult(oldSpawnResult);
        }

        // NB: Unlike newServerFailed, this includes timeouts because "it used to timeout" is useful context for an error in the new server
        const oldServerFailed = !oldSpawnResult || !!oldSpawnResult.code || !!oldSpawnResult.signal;

        if (oldServerFailed) {
            console.log(`Issue found in ${oldTsServerPath} (old):`);
            console.log(
                insetLines(
                    oldSpawnResult?.stdout
                        ? prettyPrintServerHarnessOutput(oldSpawnResult.stdout, /*filter*/ false)
                        : `Timed out after ${executionTimeout} ms`));
        }

        const owner = repo.owner ? `${mdEscape(repo.owner)}/` : "";
        const url = repo.url ? `(${repo.url})` : "";

        let summary = `## [${owner}${mdEscape(repo.name)}]${url}\n`;

        if (oldServerFailed) {
            const oldServerError = oldSpawnResult?.stdout
                ? prettyPrintServerHarnessOutput(oldSpawnResult.stdout, /*filter*/ true)
                : `Timed out after ${executionTimeout} ms`;
            summary += `
<details>
<summary>:warning: Note that ${path.basename(path.dirname(path.dirname(oldTsServerPath)))} also had errors :warning:</summary>

\`\`\`
${oldServerError}
\`\`\`

</details>

`;
        }

        summary += `

\`\`\`
${prettyPrintServerHarnessOutput(newSpawnResult.stdout, /*filter*/ true)}
\`\`\`

`;

        summary += `
<details>
<summary><h3>Last few requests</h3></summary>

\`\`\`json
${fs.readFileSync(replayScriptPath, { encoding: "utf-8" }).split(/\r?\n/).slice(-5).join("\n")}
\`\`\`

</details>

`;

        // Markdown doesn't seem to support a <details> list item, so this chunk is in HTML

        summary += `<details>
<summary><h3>Repro Steps</h3></summary>
<ol>
`;
        if (isUserTestRepo) {
            summary += `<li>Download user test <code>${repo.name}</code></li>\n`;
        }
        else {
            summary += `<li><code>git clone ${repo.url!} --recurse-submodules</code></li>\n`;

            try {
                console.log("Extracting commit SHA for repro steps");
                const commit = (await execAsync(repoDir, `git rev-parse @`)).trim();
                summary += `<li>In dir <code>${repo.name}</code>, run <code>git reset --hard ${commit}</code></li>\n`;
            }
            catch {
            }
        }

        if (installCommands.length > 1) {
            summary += "<li><details><summary>Install packages (exact steps are below, but it might be easier to follow the repo readme)</summary><ol>\n";
        }
        for (const command of installCommands) {
            summary += `  <li>In dir <code>${path.relative(downloadDir, command.directory)}</code>, run <code>${command.tool} ${command.arguments.join(" ")}</code></li>\n`;
        }
        if (installCommands.length > 1) {
            summary += "</ol></details>\n";
        }

        // The URL of the artifact can be determined via AzDO REST APIs, but not until after the artifact is published
        summary += `<li>Back in the initial folder, download <code>${replayScriptArtifactPath}</code> from the <a href="${artifactFolderUrlPlaceholder}">artifact folder</a></li>\n`;
        summary += `<li><code>npm install --no-save @typescript/server-replay</code></li>\n`;
        summary += `<li><code>npx tsreplay ./${repo.name} ./${replayScriptName} path/to/tsserver.js</code></li>\n`;
        summary += `<li><code>npx tsreplay --help</code> to learn about helpful switches for debugging, logging, etc</li>\n`;

        summary += `</ol>
</details>

`;

        return { status: "Detected interesting changes", summary, replayScriptPath };
    }
    catch (err) {
        reportError(err, `Error running tsserver on ${repo.url ?? repo.name}`);
        return { status: "Unknown failure" };
    }
    finally {
        console.log(`Done ${repo.url ?? repo.name}`);
        logStepTime(diagnosticOutput, repo, "language service", lsStart);
    }
}

// Exported for testing
export async function getTscRepoResult(
    repo: git.Repo,
    userTestsDir: string,
    oldTscPath: string,
    newTscPath: string,
    /**
     * Two possible approaches:
     *   1) If a project fails to build with the old tsc, don't bother building it with the new tsc - the results will be unrelatiable (breaking change detector)
     *   2) Errors are expected when building with the old tsc and we're specifically interested in changes (user tests)
     */
    buildWithNewWhenOldFails: boolean,
    downloadDir: string,
    diagnosticOutput: boolean): Promise<RepoResult> {

    if (!await cloneRepo(repo, userTestsDir, downloadDir, diagnosticOutput)) {
        return { status: "Git clone failed" };
    }

    const repoDir = path.join(downloadDir, repo.name);
    const monorepoPackages = await getMonorepoPackages(repoDir);

    if (!monorepoPackages || !await installPackagesAndGetCommands(repo, downloadDir, repoDir, monorepoPackages, /*cleanOnFailure*/ false, diagnosticOutput)) {
        return { status: "Package install failed" };
    }

    const isUserTestRepo = !repo.url;

    const buildStart = performance.now();
    try {
        console.log(`Building with ${oldTscPath} (old)`);
        const oldErrors = await ge.buildAndGetErrors(repoDir, monorepoPackages, isUserTestRepo, oldTscPath, executionTimeout, /*skipLibCheck*/ true);

        if (oldErrors.hasConfigFailure) {
            console.log("Unable to build project graph");
            console.log(`Skipping build with ${newTscPath} (new)`);
            return { status: "Project-graph error in old TS" };
        }

        const numProjects = oldErrors.projectErrors.length;

        let numFailed = 0;
        for (const oldProjectErrors of oldErrors.projectErrors) {
            if (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length) {
                numFailed++;
            }
        }

        if (!buildWithNewWhenOldFails && numFailed === numProjects) {
            console.log(`Skipping build with ${newTscPath} (new)`);
            return { status: "Too many errors in old TS" };
        }

        let sawDifferentErrors = false;
        const owner = repo.owner ? `${mdEscape(repo.owner)}/` : "";
        const url = repo.url ?? "";

        let summary = `<details open="true">
<summary>
<h2><a href="${url}">${owner}${mdEscape(repo.name)}</a></h2>
</summary>

`;

        if (!buildWithNewWhenOldFails && numFailed > 0) {
            const oldFailuresMessage = `${numFailed} of ${numProjects} projects failed to build with the old tsc and were ignored`;
            console.log(oldFailuresMessage);
            summary += `**${oldFailuresMessage}**\n`;
        }

        console.log(`Building with ${newTscPath} (new)`);
        const newErrors = await ge.buildAndGetErrors(repoDir, monorepoPackages, isUserTestRepo, newTscPath, executionTimeout, /*skipLibCheck*/ true);

        if (newErrors.hasConfigFailure) {
            console.log("Unable to build project graph");

            // This doesn't depend on tsc at all, so it shouldn't be possible for it to fail.
            // Throw so we don't get confusing results if the seemingly impossible happens.
            throw new Error("Project graph changed between builds");
        }

        console.log("Comparing errors");
        for (const oldProjectErrors of oldErrors.projectErrors) {
            if (!buildWithNewWhenOldFails && (oldProjectErrors.hasBuildFailure || oldProjectErrors.errors.length)) {
                continue;
            }

            const { projectUrl, isComposite } = oldProjectErrors;

            // TS 5055 generally indicates that the project can't be built twice in a row without cleaning in between.
            const newErrorList = newErrors.projectErrors.find(pe => pe.projectUrl == projectUrl)?.errors?.filter(e => e.code !== 5055) ?? [];
            // Obviously, 5055 doesn't indicate a problem with building twice if it occurs during the first build,
            // but it's still not interesting to report that it went away (which we would, since we drop it from `newErrorList`).
            const oldErrorList = oldProjectErrors.errors.filter(e => e.code !== 5055);

            console.log(`Error counts for ${projectUrl}: new = ${newErrorList.length}, old = ${oldErrorList.length}`);

            // If both succeeded, there's nothing interesting to report.
            // Sneakiness: if !buildWithNewWhenOldFails, then we already know oldErrorList is empty.
            if (!oldErrorList.length && !newErrorList.length) {
                continue;
            }

            const newlyReported = newErrorList.filter(ne => !oldErrorList.find(oe => ge.errorEquals(oe, ne)));
            const newlyUnreported = buildWithNewWhenOldFails ? oldErrorList.filter(oe => !newErrorList.find(ne => ge.errorEquals(ne, oe))) : [];

            // If the errors are exactly the same, there's nothing interesting to report.
            if (!newlyReported.length && !newlyUnreported.length) {
                continue;
            }

            sawDifferentErrors = true;

            const newlyReportedErrorMessageMap = new Map<string, ge.Error[]>();
            const newlyReportedErrorMessages: string[] = [];

            console.log(`New errors for ${isComposite ? "composite" : "non-composite"} project ${projectUrl}`);
            for (const newError of newlyReported) {
                const newErrorText = newError.text;

                console.log(`\tTS${newError.code} at ${newError.fileUrl ?? "project scope"}${isComposite ? ` in ${projectUrl}` : ``}`);
                console.log(`\t\t${newErrorText}`);

                if (!newlyReportedErrorMessageMap.has(newErrorText)) {
                    newlyReportedErrorMessageMap.set(newErrorText, []);
                    newlyReportedErrorMessages.push(newErrorText);
                }

                newlyReportedErrorMessageMap.get(newErrorText)!.push(newError);
            }

            const newlyUnreportedErrorMessageMap = new Map<string, ge.Error[]>();
            const newlyUnreportedErrorMessages: string[] = [];

            console.log(`No-longer-reported errors for ${isComposite ? "composite" : "non-composite"} project ${projectUrl}`);
            for (const oldError of newlyUnreported) {
                const oldErrorText = oldError.text;

                console.log(`\tTS${oldError.code} at ${oldError.fileUrl ?? "project scope"}${isComposite ? ` in ${oldError.projectUrl}` : ``}`);
                console.log(`\t\t${oldErrorText}`);

                if (!newlyUnreportedErrorMessageMap.has(oldErrorText)) {
                    newlyUnreportedErrorMessageMap.set(oldErrorText, []);
                    newlyUnreportedErrorMessages.push(oldErrorText);
                }

                newlyUnreportedErrorMessageMap.get(oldErrorText)!.push(oldError);
            }

            summary += `### ${makeMarkdownLink(projectUrl)}\n`;

            for (const errorMessage of newlyReportedErrorMessages) {
                summary += ` - ${buildWithNewWhenOldFails ? "[NEW] " : ""}\`${errorMessage}\`\n`;

                for (const error of newlyReportedErrorMessageMap.get(errorMessage)!) {
                    summary += `   - ${error.fileUrl ? makeMarkdownLink(error.fileUrl) : "Project Scope"}${isComposite ? ` in ${makeMarkdownLink(error.projectUrl)}` : ``}\n`;
                }
            }

            for (const errorMessage of newlyUnreportedErrorMessages) {
                summary += ` - ${buildWithNewWhenOldFails ? "[MISSING] " : ""}\`${errorMessage}\`\n`;

                for (const error of newlyUnreportedErrorMessageMap.get(errorMessage)!) {
                    summary += `   - ${error.fileUrl ? makeMarkdownLink(error.fileUrl) : "Project Scope"}${isComposite ? ` in ${makeMarkdownLink(error.projectUrl)}` : ``}\n`;
                }
            }
        }

        summary += "\n</details>\n\n";

        if (sawDifferentErrors) {
            return { status: "Detected interesting changes", summary };
        }
    }
    catch (err) {
        reportError(err, `Error building ${repo.url ?? repo.name}`);
        return { status: "Unknown failure" };
    }
    finally {
        logStepTime(diagnosticOutput, repo, "build", buildStart);
    }

    return { status: "Detected no interesting changes" };
}

export const metadataFileName = "metadata.json";
export const resultFileNameSuffix = "results.txt";
export const replayScriptFileNameSuffix = "replay.txt";
export const artifactFolderUrlPlaceholder = "PLACEHOLDER_ARTIFACT_FOLDER";

export type StatusCounts = {
    [P in RepoStatus]?: number
};

export interface Metadata {
    readonly newTsResolvedVersion: string;
    readonly oldTsResolvedVersion: string;
    readonly statusCounts: StatusCounts;
}

function getWorkerRepos(allRepos: readonly git.Repo[], workerCount: number, workerNumber: number): git.Repo[] {
    const workerIndex = workerNumber - 1;
    const repoCount = allRepos.length;
    const batchSize = Math.ceil(repoCount / workerCount);
    const start = workerIndex * batchSize;
    const end = Math.min((workerIndex + 1) * batchSize, repoCount);
    console.log(`Worker ${workerNumber} will process repos [${start}, ${end})`);
    return allRepos.slice(start, end);
}

export async function mainAsync(params: GitParams | UserParams): Promise<void> {
    if (params.prngSeed) {
        prng.seed(params.prngSeed);
    }

    const downloadDir = params.tmpfs ? "/mnt/ts_downloads" : path.join(processCwd, "ts_downloads");
    // TODO: check first whether the directory exists and skip downloading if possible
    // TODO: Seems like this should come after the typescript download
    if (params.tmpfs)
        await execAsync(processCwd, "sudo mkdir " + downloadDir);
    else
        await execAsync(processCwd, "mkdir " + downloadDir);

    const resultDirPath = path.join(processCwd, params.resultDirName);

    if (!(await pu.exists(resultDirPath))) {
        await fs.promises.mkdir(resultDirPath, { recursive: true });
    }

    // TODO: Only download if the commit has changed (need to map refs to commits and then download to typescript-COMMIT instead)
    const { oldTsEntrypointPath, oldTsResolvedVersion, newTsEntrypointPath, newTsResolvedVersion } = await downloadTsAsync(processCwd, params);

    // Get the name of the typescript folder.
    const oldTscDirPath = path.resolve(oldTsEntrypointPath, "../../");
    const newTscDirPath = path.resolve(newTsEntrypointPath, "../../");

    console.log("Old version = " + oldTsResolvedVersion);
    console.log("New version = " + newTsResolvedVersion);

    const userTestsDir = path.join(processCwd, "userTests");

    const allRepos: readonly git.Repo[] = JSON.parse(fs.readFileSync(params.repoListPath, { encoding: "utf-8" }));
    const repos = getWorkerRepos(allRepos, params.workerCount, params.workerNumber);

    // An object is easier to de/serialize than a real map
    const statusCounts: { [P in RepoStatus]?: number } = {};

    let i = 1;
    for (const repo of repos) {
        console.log(`Starting #${i++} / ${repos.length}: ${repo.url ?? repo.name}`);
        if (params.tmpfs) {
            await execAsync(processCwd, "sudo mount -t tmpfs -o size=4g tmpfs " + downloadDir);
        }

        const diagnosticOutput = !!params.diagnosticOutput;
        try {
            const repoPrefix = repo.owner
                ? `${repo.owner}.${repo.name}`
                : repo.name;
            const replayScriptFileName = `${repoPrefix}.${replayScriptFileNameSuffix}`;
            const { status, summary, replayScriptPath } = params.entrypoint === "tsc"
                ? await getTscRepoResult(repo, userTestsDir, oldTsEntrypointPath, newTsEntrypointPath, params.buildWithNewWhenOldFails, downloadDir, diagnosticOutput)
                : await getTsServerRepoResult(repo, userTestsDir, oldTsEntrypointPath, newTsEntrypointPath, downloadDir, path.join(params.resultDirName, replayScriptFileName), diagnosticOutput);
            console.log(`Repo ${repo.url ?? repo.name} had status "${status}"`);
            statusCounts[status] = (statusCounts[status] ?? 0) + 1;
            if (summary) {

                const resultFileName = `${repoPrefix}.${resultFileNameSuffix}`;
                await fs.promises.writeFile(path.join(resultDirPath, resultFileName), summary, { encoding: "utf-8" });

                // In practice, there will only be a replay script when the entrypoint is tsserver
                // There can be replay steps without a summary, but then they're not interesting
                if (replayScriptPath) {
                    await fs.promises.copyFile(replayScriptPath, path.join(resultDirPath, replayScriptFileName));
                }
            }

        }
        finally {
            // Throw away the repo so we don't run out of space
            // Note that we specifically don't recover and attempt another repo if this fails
            console.log("Cleaning up repo");
            if (params.tmpfs) {
                if (diagnosticOutput) {
                    // Dump any processes holding onto the download directory in case umount fails
                    await execAsync(processCwd, `lsof -K i | grep ${downloadDir} || true`);
                }
                try {
                    await execAsync(processCwd, "sudo umount " + downloadDir);
                }
                catch (e) {
                    // HACK: Sometimes the server lingers for a brief period, so retry.
                    // Obviously, it would be better to have a way to know when it is gone-gone,
                    // but Linux doesn't provide such a mechanism for non-child processes.
                    // (You can poll for a process with the given PID after sending a kill signal,
                    // but best practice is to guard against the possibility of a new process
                    // being given the same PID.)
                    try {
                        console.log("umount failed - trying again after delay");
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        await execAsync(processCwd, "sudo umount " + downloadDir);
                    }
                    catch {
                        await execAsync(processCwd, `pstree -palT`);
                        throw e;
                    }
                }
            }
        }
    }

    if (params.tmpfs) {
        await execAsync(processCwd, "sudo rm -rf " + downloadDir);
        await execAsync(processCwd, "sudo rm -rf " + oldTscDirPath);
        await execAsync(processCwd, "sudo rm -rf " + newTscDirPath);
    }
    else {
        await execAsync(processCwd, "rm -rf " + downloadDir);
        await execAsync(processCwd, "rm -rf " + oldTscDirPath);
        await execAsync(processCwd, "rm -rf " + newTscDirPath);
    }

    console.log("Statuses");
    for (const status of Object.keys(statusCounts).sort()) {
        console.log(`${status}\t${statusCounts[status as RepoStatus]}`);
    }

    const metadata: Metadata = {
        newTsResolvedVersion: newTsResolvedVersion,
        oldTsResolvedVersion: oldTsResolvedVersion,
        statusCounts,
    };
    await fs.promises.writeFile(path.join(resultDirPath, metadataFileName), JSON.stringify(metadata), { encoding: "utf-8" });
}

async function installPackages(repoDir: string, commands: readonly ip.InstallCommand[], timeoutMs: number) {
    let usedYarn = false;
    try {
        let timedOut = false;
        const startMs = performance.now();
        for (const { directory: packageRoot, tool, arguments: args } of commands) {
            if (timedOut) break;

            usedYarn = usedYarn || tool === ip.InstallTool.Yarn;

            const elapsedMs = performance.now() - startMs;
            const packageRootDescription = packageRoot.substring(repoDir.length + 1) || "root directory";

            // yarn2 produces extremely verbose output unless CI=true is set and it should be harmless for yarn1 and npm
            const spawnResult = await spawnWithTimeoutAsync(packageRoot, tool, args, timeoutMs - elapsedMs, { ...process.env, CI: "true" });
            if (!spawnResult) {
                throw new Error(`Timed out after ${timeoutMs} ms`);
            }

            if (spawnResult.code || spawnResult.signal) {
                if (tool === ip.InstallTool.Npm && args[0] === "ci" && /update your lock file/.test(spawnResult.stderr)) {
                    const elapsedMs2 = performance.now() - startMs;
                    const args2 = args.slice();
                    args2[0] = "install";
                    const spawnResult2 = await spawnWithTimeoutAsync(packageRoot, tool, args2, timeoutMs - elapsedMs2, { ...process.env, CI: "true" });
                    if (spawnResult2 && !spawnResult2.code && !spawnResult2.signal) {
                        continue; // Succeeded on retry
                    }
                }

                const errorText = `Exited with ${spawnResult.code ? `code ${spawnResult.code}` : `signal ${spawnResult.signal}`}
${spawnResult.stdout.trim() || "No stdout"}\n${spawnResult.stderr.trim() || "No stderr"}`;

                if (!/ENOSPC/.test(errorText) && (/(?:ex|s)amples?\//i.test(packageRootDescription) || /tests?\//i.test(packageRootDescription))) {
                    console.log(`Ignoring package install error from non-product folder ${packageRootDescription}:`);
                    console.log(insetLines(reduceSpew(errorText)));
                }
                else {
                    throw new Error(`Failed to install packages for ${packageRootDescription}:\n${errorText}`);
                }
            }
        }
    }
    finally {
        if (usedYarn) {
            await execAsync(repoDir, "yarn cache clean --all");
        }
    }
}

async function reportResourceUsage(downloadDir: string) {
    try {
        console.log("Memory");
        await execAsync(processCwd, "free -h");
        console.log("Disk");
        await execAsync(processCwd, "df -h");
        await execAsync(processCwd, "df -i");
        console.log("Download Directory");
        await execAsync(processCwd, "ls -lh " + downloadDir);
        console.log("Home Directory");
        await execAsync(processCwd, "du -csh ~/.[^.]*");
        await execAsync(processCwd, "du -csh ~/.cache/*");
    }
    catch { } // noop
}

export function reportError(err: any, message: string) {
    console.log(`${message}:`);
    if (err.message && err.stack && err.stack.indexOf(err.message) >= 0) {
        console.log(insetLines(reduceSpew(err.stack)));
    }
    else {
        console.log(insetLines(reduceSpew(err.message ?? "No message")));
        console.log(insetLines(err.stack ?? "Unknown Stack"));
    }
}

function dumpSpawnResult(spawnResult: SpawnResult): void {
    console.log(`ExitCode: ${spawnResult.code}
Signal: ${spawnResult.signal}
stdout:
>>>
${spawnResult.stdout}
<<<
stderr:
>>>
${spawnResult.stderr}
<<<
`);
}

function prettyPrintServerHarnessOutput(error: string, filter: boolean): string {
    try {
        const errorObj = JSON.parse(error);
        if (errorObj.message) {
            return `Req #${errorObj.request_seq} - ${errorObj.command}
${filter ? filterToTsserverLines(errorObj.message) : errorObj.message}`;
        }

        // It's not really clear how this could happen, but reporting the whole repsonse should be fine
        // if there's no message property
        return JSON.stringify(errorObj, undefined, 2);
    }
    catch {
        // Sometimes, the response isn't JSON and that's fine
        return error;
    }
}

function filterToTsserverLines(stackLines: string): string {
    const tsserverRegex = /^.*tsserver\.js.*$/mg;
    let tsserverLines = "";
    let match;
    while (match = tsserverRegex.exec(stackLines)) {
        tsserverLines += match[0].replace(processCwd, "") + "\n";
    }
    return tsserverLines.trimEnd();
}

function insetLines(text: string): string {
    return text.trimEnd().replace(/(^|\n)/g, "$1> ");
}

function reduceSpew(message: string): string {
    // These are uninteresting in general and actually problematic when there are
    // thousands of instances of ENOSPC (which also appears as an error anyway)
    return message.replace(/npm WARN.*\n/g, "");
}

function makeMarkdownLink(url: string) {
    const match = /\/blob\/[a-f0-9]+\/(.+)$/.exec(url);
    return !match
        ? url
        : `[${mdEscape(match[1])}](${url})`;
}

async function downloadTsAsync(cwd: string, params: GitParams | UserParams): Promise<{ oldTsEntrypointPath: string, oldTsResolvedVersion: string, newTsEntrypointPath: string, newTsResolvedVersion: string }> {
    const entrypoint = params.entrypoint;
    if (params.testType === "user") {
        const { tsEntrypointPath: oldTsEntrypointPath, resolvedVersion: oldTsResolvedVersion } = await downloadTsRepoAsync(cwd, params.oldTsRepoUrl, params.oldHeadRef, entrypoint);
        // We need to handle the ref/pull/*/merge differently as it is not a branch and cannot be pulled during clone.
        const { tsEntrypointPath: newTsEntrypointPath, resolvedVersion: newTsResolvedVersion } = await downloadTsPrAsync(cwd, params.oldTsRepoUrl, params.prNumber, entrypoint);

        return {
            oldTsEntrypointPath,
            oldTsResolvedVersion,
            newTsEntrypointPath,
            newTsResolvedVersion
        };
    }
    else if (params.testType === "github") {
        const { tsEntrypointPath: oldTsEntrypointPath, resolvedVersion: oldTsResolvedVersion } = await downloadTsNpmAsync(cwd, params.oldTsNpmVersion, entrypoint);
        const { tsEntrypointPath: newTsEntrypointPath, resolvedVersion: newTsResolvedVersion } = await downloadTsNpmAsync(cwd, params.newTsNpmVersion, entrypoint);

        return {
            oldTsEntrypointPath,
            oldTsResolvedVersion,
            newTsEntrypointPath,
            newTsResolvedVersion
        };
    }
    else {
        throw new Error("Invalid parameters");
    }
}

export async function downloadTsRepoAsync(cwd: string, repoUrl: string, headRef: string, target: TsEntrypoint): Promise<{ tsEntrypointPath: string, resolvedVersion: string }> {
    const repoName = `typescript-${headRef}`;
    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl, branch: headRef });

    const repoPath = path.join(cwd, repoName);

    return {
        tsEntrypointPath: await buildTs(repoPath, target),
        resolvedVersion: headRef
    };
}

async function downloadTsPrAsync(cwd: string, repoUrl: string, prNumber: number, target: TsEntrypoint): Promise<{ tsEntrypointPath: string, resolvedVersion: string }> {
    const repoName = `typescript-${prNumber}`;
    await git.cloneRepoIfNecessary(cwd, { name: repoName, url: repoUrl });

    const repoPath = path.join(cwd, repoName);
    const headRef = `refs/pull/${prNumber}/merge`;

    await git.checkout(repoPath, headRef);

    return {
        tsEntrypointPath: await buildTs(repoPath, target),
        resolvedVersion: headRef
    };
}

async function buildTs(repoPath: string, entrypoint: TsEntrypoint) {
    await execAsync(repoPath, "npm ci");
    await execAsync(repoPath, `npx gulp ${entrypoint}`);

    if (entrypoint === "tsc") {
        // We build the LKG for the benefit of scenarios that want to install it as an npm package
        await execAsync(repoPath, "npx gulp configure-insiders");
        await execAsync(repoPath, "npx gulp LKG");
    }

    return path.join(repoPath, "built", "local", `${entrypoint}.js`);
}

async function downloadTsNpmAsync(cwd: string, version: string, entrypoint: TsEntrypoint): Promise<{ tsEntrypointPath: string, resolvedVersion: string }> {
    const tarName = (await execAsync(cwd, `npm pack typescript@${version} --quiet`)).trim();

    const tarMatch = /^(typescript-(.+))\..+$/.exec(tarName);
    if (!tarMatch) {
        throw new Error("Unexpected tarball name format: " + tarName);
    }

    const resolvedVersion = tarMatch[2];
    const dirName = tarMatch[1];
    const dirPath = path.join(processCwd, dirName);

    await execAsync(cwd, `tar xf ${tarName} && rm ${tarName}`);
    await fs.promises.rename(path.join(processCwd, "package"), dirPath);

    const tsEntrypointPath = path.join(dirPath, "lib", `${entrypoint}.js`);
    if (!await pu.exists(tsEntrypointPath)) {
        throw new Error("Cannot find file " + tsEntrypointPath);
    }

    return { tsEntrypointPath, resolvedVersion };
}
