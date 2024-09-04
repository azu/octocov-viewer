import type { PlasmoCSConfig } from "plasmo"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import type { Octocov } from "./OctocovType";

export const config: PlasmoCSConfig = {
  // github.com
  matches: ["https://github.com/*"],
  world: "MAIN"
}
// https://github.com/azu/octocov-gh-viewer/pull/1
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
const cacheFn = async (key: string, fn: () => JSONValue | Promise<JSONValue>) => {
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
const fetchWorkflowId = async (options: OnPullRequestPageOptions) => {
  const { owner, repo, prNumber } = options.context
  // fetch /pull/<num>/checks page
  const checkRes = await fetch(`https://github.com/${owner}/${repo}/pull/${prNumber}/checks`);
  const parser = new DOMParser();
  const checkResHTML = parser.parseFromString(await checkRes.text(), "text/html");
  // hrefに　/run/<workflowid> を含むリンクを取得
  const workflowLinks = Array.from(checkResHTML.querySelectorAll("a")).filter(a => {
    return a.href.includes("/runs/");
  });
  const workflowLink = workflowLinks.find(a => options.coverageWorkflowPattern.test(a.textContent));
  if (!workflowLink) {
    console.info("Not found coverage workflow link");
    return;
  }
  // get <workflowid>
  const match = workflowLink.href.match(/\/runs\/(\d+)/);
  return match?.[1];
}
type ArtifactOptions = {
  context: PullRequestContext;
  workflowId: string;
  artifactNamePattern: RegExp;
}
const fetchArtifactId = async (options: ArtifactOptions) => {
  const { owner, repo, prNumber } = options.context
  const { workflowId } = options
  // fetch /run/<workflowid> page
  const runRes = await fetch(`https://github.com/${owner}/${repo}/actions/runs/${workflowId}`);
  const parser = new DOMParser();
  const runResHTML = parser.parseFromString(await runRes.text(), "text/html");
  // artifact link: /runs/<workflowid>/artifacts/<artifactid>
  const artifactLinks = Array.from(runResHTML.querySelectorAll("a")).filter(a => {
    return a.href.includes(`/artifacts/`);
  });
  const artifactLink = artifactLinks.find(a => options.artifactNamePattern.test(a.textContent));
  if (!artifactLink) {
    console.info("Not found coverage artifact link");
    return;
  }
  const match = artifactLink.href.match(/\/artifacts\/(\d+)/);
  return match?.[1];
}
type DownloadArtifactOptions = {
  context: PullRequestContext;
  workflowId: string;
  artifactId: string;
}
const downloadArtifact = async (options: DownloadArtifactOptions) => {
  const { owner, repo } = options.context
  const { workflowId, artifactId } = options
  // it will be redirect to actual blob url
  const artifactDownloadUrl = `https://github.com/${owner}/${repo}/actions/runs/${workflowId}/artifacts/${artifactId}`;
  console.info("artifactDownloadUrl", artifactDownloadUrl);
  const downloadRes = await fetch(artifactDownloadUrl, {
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

const onPullRequestPage = async (options: OnPullRequestPageOptions) => {
  const baseKey = `${options.context.owner}/${options.context.repo}/${options.context.prNumber}`;
  const workflowIdCacheKey = `${baseKey}:workflowId`
  console.info("start fetchWorkflowId");
  const workflowId = await cacheFn(workflowIdCacheKey, () => fetchWorkflowId(options));
  if (!workflowId) {
    console.info("Not found coverage workflow");
    return;
  }
  console.info("workflowId", workflowId);
  // artifact
  console.info("start fetchArtifactId");
  const artifactIdCacheKey = `${baseKey}:artifactId`
  const artifactId = await cacheFn(artifactIdCacheKey, () => fetchArtifactId({
    context: options.context,
    workflowId,
    artifactNamePattern: options.artifactNamePattern,
  }));
  if (!artifactId) {
    console.info("Not found coverage artifact");
    return;
  }
  console.info("artifactId", artifactId);
  // download
  console.info("start downloadArtifact");
  const artifactFileCacheKey = `${baseKey}:artifactFile`
  const octocovJSON = await cacheFn(artifactFileCacheKey, () => downloadArtifact({
    context: options.context,
    workflowId,
    artifactId,
  }));
  if (!octocovJSON) {
    console.info("Not found coverage artifact file");
    return;
  }
  console.info("octocovJSON", octocovJSON);
  return {
    workflowId,
    artifactId,
    octocovJSON
  }
};

// Diff Page
const normalizeFilePath = (path: string, context: PullRequestContext) => {
  // "github.com/azu/octocov-gh-viewer/go/hello.go" -> "go/hello.go"
  return path.replace(`github.com/${context.owner}/${context.repo}/`, "");
}

/**
 *
 * @param octocov
 * @param {string} filePath
 * @param {number} lineNumber
 * @param context
 * @return {"covered" | "uncovered" | "unknown"}
 */
function coverageLineNumber(octocov: Octocov, filePath: string, lineNumber: number, context: PullRequestContext) {
  const targetFile = octocov.coverage.files.find((file) => {
    return normalizeFilePath(file.file, context) === filePath;
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
function iterateFile(octocov: Octocov, element: HTMLElement, filePath: string, context: PullRequestContext) {
  // 2nd column is line number
  const lineElements = Array.from(element.querySelectorAll("tr > [data-line-number]:nth-child(2):not(.blob-num-deletion)")) as HTMLElement[];
  const visibleLines = Array.from(lineElements, (lineElement) => {
    return Number.parseInt(lineElement.dataset.lineNumber, 10);
  });
  const coveredLines = visibleLines.map((lineNumber) => {
    return coverageLineNumber(octocov, filePath, lineNumber, context);
  });
  lineElements.forEach((lineElement, index) => {
    const parentLineElement = lineElement.parentElement;
    const status = coveredLines[index];
    highlightLine(parentLineElement, visibleLines[index], status);
  });
}

(async function main() {
  const url = new URL(location.href);
  // named capture
  const prMatch = url.pathname.match(/\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<prNumber>\d+)/);
  const prFilesMatch = url.pathname.match(/\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<prNumber>\d+)\/files/);
  // diff page
  if (prFilesMatch) {
    const { owner, repo, prNumber } = prMatch.groups;
    const context = {
      owner,
      repo,
      prNumber: Number(prNumber),
    }
    const result = await onPullRequestPage({
      context,
      coverageWorkflowPattern: /Go Test/i,
      artifactNamePattern: /octocov/i,
    });
    const octocov = result.octocovJSON;
    const targetFileElement = Array.from(document.querySelectorAll("[data-tagsearch-path]")) as HTMLElement[];
    if (targetFileElement.length === 0) {
      console.info("Not found target file");
      return;
    }
    const targetFilePaths = Array.from(targetFileElement, (element) => {
      return element.dataset.tagsearchPath;
    });
    targetFilePaths.forEach((filePath, index) => {
      console.info("highlight filePath", filePath);
      iterateFile(octocov, targetFileElement[index], filePath, context);
    });
  } else if (prMatch) {
    // pr page - fetch and cache
    const { owner, repo, prNumber } = prMatch.groups;
    const result = await onPullRequestPage({
      context: {
        owner,
        repo,
        prNumber: Number(prNumber),
      },
      coverageWorkflowPattern: /Go Test/i,
      artifactNamePattern: /octocov/i,
    });
    console.info("result", result);
  }
})();
