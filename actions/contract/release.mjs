// Finds the release that runs in Production, and downloads a file of that release.
// A release of a service holds the assets contract.json and expectations.json, and, after a successful deployment
// to Production, the marker deployed-production.json. The README section "Contract tests" explains why.
//
// Every function gets `gh` as an argument: gh(args) runs `gh <args>` and returns the output text.
// The tests give a fake. The command line gives the real one (see cli.mjs).
import { MARKER_ASSET } from './lib.mjs';

// The lab names the repository of a service lab-svc-<name>, except for web. preflight.sh has the same rule.
export function repositoryOf(service) {
  return service === 'web' ? 'lab-web' : `lab-svc-${service}`;
}

// The tag of a release is v<version>.
export function versionOf(release) {
  return String(release.tag_name).replace(/^v/, '');
}

// All the releases of a repository, newest created first. The API sends 100 on a page. --slurp joins the pages.
export function listReleases(repo, gh) {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  return pages.flat();
}

// The release that runs in Production: the release with the newest marker.
// A release is a candidate when it is not a draft and has the asset `marker` with a finished upload.
// The newest marker wins by the time of its upload (updated_at), and not by the version. A redeploy of an older
// version uploads the marker again on the older release, and so that release becomes the newest.
// Returns the release object of the API (with its assets), or null if no release has the marker.
export function findProductionRelease(repo, gh, marker = MARKER_ASSET) {
  let best = null;
  for (const release of listReleases(repo, gh)) {
    if (release.draft) continue;
    const found = (release.assets ?? []).find((asset) => asset.name === marker && asset.state === 'uploaded');
    if (!found) continue;
    const at = Date.parse(found.updated_at);
    if (Number.isNaN(at)) continue;
    // Two markers with the same time are unlikely. The newer release (the higher id) wins then, so the answer is stable.
    if (best === null || at > best.at || (at === best.at && release.id > best.release.id)) best = { at, release };
  }
  return best === null ? null : best.release;
}

// The text of one asset of a release, or null if the release has no such asset.
// The API sends the file itself when the header Accept asks for application/octet-stream.
export function fetchAsset(repo, release, name, gh) {
  const asset = (release.assets ?? []).find((candidate) => candidate.name === name && candidate.state === 'uploaded');
  if (!asset) return null;
  return gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`]);
}
