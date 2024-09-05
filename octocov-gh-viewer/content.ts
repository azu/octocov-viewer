import type { PlasmoCSConfig } from "plasmo"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import type { Octocov } from "./OctocovType";

export const config: PlasmoCSConfig = {
  // github.com
  matches: ["https://github.com/*"],
  world: "MAIN"
}
const storage = {
  get(key: string) {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) : null
  },
  set(key: string, value: JSONValue) {
    return sessionStorage.setItem(key, JSON.stringify(value))
  },
}
type JSONValue = string | number | boolean | null | { [key: string]: JSONValue } | JSONValue[] | Octocov;
const cacheFn = async <R extends JSONValue | Octocov>(key: string, fn: () => Promise<R>): Promise<R> => {
  const value = storage.get(key)
  if (value) {
    return value
  }
  const newValue = await fn()
  if (!newValue) {
    return;
  }
  storage.set(key, newValue)
  return newValue
}

type PullRequestContext = {
  owner: string;
  repo: string;
  prNumber: number;
}
type OnPullRequestPageOptions = {
  context: PullRequestContext;
  coverageWorkflowPattern: RegExp;
  artifactNamePattern: RegExp;
}
/**
 * Download Octocov report and extract it and parse it
 * Return Octocov JSON
 * @param octocovReportUrl
 */
const downloadOctocovReport = async (octocovReportUrl: string): Promise<Octocov> => {
  const downloadRes = await fetch(octocovReportUrl, {
    method: "HEAD",
  });
  const finalBlobUrl = downloadRes.url;
  console.info("finalBlobUrl", finalBlobUrl);
  try {
    const blobRes = await fetch(finalBlobUrl);
    const zipFileReader = new BlobReader(await blobRes.blob());
    const helloWorldWriter = new TextWriter();
    const zipReader = new ZipReader(zipFileReader);
    const firstEntry = (await zipReader.getEntries()).shift();
    const octocovFileData = await firstEntry.getData(helloWorldWriter);
    await zipReader.close();
    return JSON.parse(octocovFileData) as Octocov;
  } catch (e) {
    console.error(e);
  }
}

type OnCommitShaOptions = {
  context: PullRequestContext;
  commitSha: string;
}
const fetchOctocovReportUrl = async (options: OnCommitShaOptions) => {
  // e.g. https://github.com/azu/octocov-gh-viewer/commit/178c452f4136e7019129a39be8186157892882e9/status-details
  // extract status details and get artifact url
  const { owner, repo, prNumber } = options.context
  const checkFragmentUrl = `https://github.com/${owner}/${repo}/commit/${options.commitSha}/status-details`;
  console.info("checkFragmentUrl", checkFragmentUrl);
  const statusDetailsUrlFragmentRes = await fetch(checkFragmentUrl, {
    headers: {
      accept: "text/html",
      "X-Requested-With": "XMLHttpRequest" // This is required to get the status details page
    }
  });
  const parser = new DOMParser();
  const statusDetailsHTML = parser.parseFromString(await statusDetailsUrlFragmentRes.text(), "text/html");
  const octocovReportStatusContextName = "octocov-report";
  // Get Artifact URL from Commit Status Link
  const statusLinks = statusDetailsHTML.querySelectorAll<HTMLAnchorElement>(".status-actions[href]");
  // https://github.com/azu/octocov-gh-viewer/actions/runs/10713070183/artifacts/1894254504
  const artifactUrlPattern = /https:\/\/github.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/actions\/runs\/(?<runId>\d+)\/artifacts\/(?<artifactId>\d+)/;
  const artifactUrl = Array.from(statusLinks).find((link) => {
    // "octocov-report" is a search keyword
    // user need to set this keyword in the status context
    return link.ariaLabel.includes(octocovReportStatusContextName) && artifactUrlPattern.test(link.href);
  }) as HTMLAnchorElement | undefined;
  if (artifactUrl) {
    return artifactUrl.href;
  }
  // Get Artifact URL from Pull Request Check
  if (!artifactUrl) {
    const checkSuites = statusDetailsHTML.querySelectorAll(".merge-status-item ");
    for (const checkSuite of Array.from(checkSuites)) {
      const textContent = checkSuite.textContent;
      if (!textContent.includes(octocovReportStatusContextName)) {
        continue;
      }
      const match = checkSuite.textContent.match(artifactUrlPattern);
      if (match) {
        return match[0];
      }
    }
  }
  console.info("Not found artifact url");
  return undefined;
}

const getCommitShaInPullRequestFilesPage = (): string | undefined => {
  const commits = Array.from(document.querySelectorAll("[data-commit]"), (e: HTMLElement) => {
    return e.dataset.commit
  });
  return commits.at(-1);
}

/**
 *
 * @param octocov
 * @param {string} filePath
 * @param {number} lineNumber
 * @return {"covered" | "uncovered" | "unknown"}
 */
function coverageLineNumber(octocov: Octocov, filePath: string, lineNumber: number) {
  const targetFile = octocov.coverage.files.find((file) => {
    return file.__relativePathFromRoot__ === filePath;
  });
  if (!targetFile) {
    return "unknown";
  }
  const targetBlock = targetFile.blocks.find((block) => {
    return block.start_line <= lineNumber && lineNumber <= block.end_line;
  });
  if (!targetBlock) {
    return "unknown";
  }
  return targetBlock.count === 0 ? "uncovered" : "covered";
}

/**
 * @param lineElementP
 * @param {number} lineNumber
 * @param {"covered" | "uncovered" | "unknown"} status
 */
function highlightLine(lineElementP: HTMLElement, lineNumber: number, status: "covered" | "uncovered" | "unknown") {
  const lineNumberElement = lineElementP.querySelector("[data-line-number]:nth-child(2)") as HTMLDListElement | null;
  if (!lineNumberElement) {
    return;
  }
  // x mark if uncovered
  // ✓ mark if covered
  // ? mark if unknown
  if (status === "covered") {
    lineNumberElement.style.backgroundColor = "rgba(0, 255, 0, 0.1)";
    lineNumberElement.insertAdjacentHTML("beforeend", "<span style='color: green; padding-left: 0.5em'>✓</span>");
  }
  if (status === "uncovered") {
    lineNumberElement.style.backgroundColor = "rgba(255, 0, 0, 0.1)";
    lineNumberElement.insertAdjacentHTML("beforeend", "<span style='color: red; padding-left: 0.5em'>✗</span>");
  }
  if (status === "unknown") {
    // lineElement.style.backgroundColor = "rgba(0, 0, 0, 0.1)";
    // lineElement.insertAdjacentHTML("beforeend", "<span style='color: black;'>?</span>");
  }
}

/**
 * @param octocov
 * @param {Element} element
 * @param {string} filePath
 */
function iterateFile(octocov: Octocov, element: HTMLElement, filePath: string) {
  // 2nd column is line number
  const lineElements = Array.from(element.querySelectorAll("tr > [data-line-number]:nth-child(2):not(.blob-num-deletion)")) as HTMLElement[];
  const visibleLines = Array.from(lineElements, (lineElement) => {
    return Number.parseInt(lineElement.dataset.lineNumber, 10);
  });
  const coveredLines = visibleLines.map((lineNumber) => {
    return coverageLineNumber(octocov, filePath, lineNumber);
  });
  console.log({
    filePath,
    coveredLines
  })
  lineElements.forEach((lineElement, index) => {
    const parentLineElement = lineElement.parentElement;
    const status = coveredLines[index];
    highlightLine(parentLineElement, visibleLines[index], status);
  });
}

type OnPullRequestFilesPageResult = {
  status: "marked" | "no-marked" | "not-found" | "error";
}
const fetchOctocovJSON = async (context: PullRequestContext): Promise<Octocov | null> => {
  const commitSha = getCommitShaInPullRequestFilesPage();
  if (!commitSha) {
    console.info("Not found commitSha");
    return null;
  }
  console.info("commitSha", commitSha);
  const octocovReportUrl = await cacheFn(`${commitSha}:octocovReportUrl`, () => fetchOctocovReportUrl({
    context,
    commitSha,
  }));
  if (!octocovReportUrl) {
    console.info("Not found octocovReportUrl");
    return null;
  }
  console.info("octocovReportUrl", octocovReportUrl);
  const octocovJSON = await cacheFn(`${commitSha}:octocovJSON`, () => downloadOctocovReport(octocovReportUrl));
  if (!octocovJSON) {
    console.info("Not found octocovJSON");
    return null;
  }
  console.info("octocovJSON", octocovJSON);
  return octocovJSON;
}

(async function main() {
  // checked set for file path
  const checkSet = new Set<string>();
  const highlightElement = (octocovJSON: Octocov) => {
    const targetFileElement = Array.from(document.querySelectorAll("[data-tagsearch-path]")) as HTMLElement[];
    if (targetFileElement.length === 0) {
      console.info("Not found target file");
      return {
        status: "no-marked"
      };
    }
    const targetFilePaths = Array.from(targetFileElement, (element) => {
      return element.dataset.tagsearchPath;
    });
    targetFilePaths.forEach((filePath, index) => {
      console.info("highlight filePath", filePath);
      if (checkSet.has(filePath)) {
        return;
      }
      iterateFile(octocovJSON, targetFileElement[index], filePath);
      checkSet.add(filePath);
    });
    return {
      status: "marked"
    };
  }
  const fetchOctocovJsonFromPRFile = async () => {
    const url = new URL(location.href);
    const prMatch = url.pathname.match(/\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<prNumber>\d+)\/files/);
    console.log({
      prMatch
    })
    if (!prMatch) {
      return;
    }
    const { owner, repo, prNumber } = prMatch.groups;
    const context = { owner, repo, prNumber: Number(prNumber) };
    return fetchOctocovJSON(context)
  }
  // initial
  let octocovJSON: Octocov | null = null;
  octocovJSON = await fetchOctocovJsonFromPRFile();
  if (octocovJSON) {
    console.log("initial highlight", octocovJSON);
    highlightElement(octocovJSON);
  }
  // watch url change
  let prevUrl = window.location.href;
  setInterval(async () => {
    if (prevUrl !== window.location.href) {
      prevUrl = window.location.href;
      octocovJSON = await fetchOctocovJsonFromPRFile();
    }
    if (octocovJSON) {
      highlightElement(octocovJSON);
    }
  }, 1000);
})();
